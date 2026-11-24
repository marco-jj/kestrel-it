import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InventoryIdSchema,
  inventoryMoney,
  inventoryName,
  inventoryNote,
  type AuthenticatedUserContext,
  type DatatableQuery,
  type SelectlistQuery,
} from '@kestrel-it/shared';
import { and, asc, count, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import {
  actionLogs,
  assetMaintenances,
  assets,
  maintenanceTypes,
  suppliers,
  users,
} from '../../db/schema/index.js';
import { fieldIssue } from './custom-fields-validation.service.js';
import { FmcsScopeService, type FmcsScope } from './fmcs-scope.service.js';
import { HardwareService } from './hardware.service.js';
import {
  contains,
  inventoryWrite,
  parse,
  selectlist,
  success,
  type InventoryDatabase,
} from './inventory-queries.js';
import {
  actionHistory,
  activeReference,
  inventoryPage,
  requireInventoryPermission,
  writeInventoryLog,
} from './phase-three-queries.js';

const reference = InventoryIdSchema.nullable().optional();
export const MaintenanceInputSchema = z.object({
  asset_id: InventoryIdSchema,
  name: inventoryName,
  maintenance_type_id: InventoryIdSchema,
  supplier_id: reference,
  responsible_party_id: reference,
  is_warranty: z.boolean().optional(),
  start_date: z.string().date(),
  expected_completion_date: z.string().date().nullable().optional(),
  cost: inventoryMoney.nullable().optional(),
  notes: inventoryNote,
  url: z
    .string()
    .trim()
    .url()
    .max(500)
    .refine((value) => /^https?:/i.test(value))
    .nullable()
    .optional(),
});
export const MaintenanceChangeSchema = z.object({
  note: inventoryNote,
  completed_at: z.string().date().optional(),
});
export const MaintenanceTypeInputSchema = z.object({ name: inventoryName });
const table = assetMaintenances;
const fields = {
  id: table.id,
  asset_id: table.itemId,
  name: table.name,
  maintenance_type_id: table.maintenanceTypeId,
  maintenance_type: table.assetMaintenanceType,
  supplier_id: table.supplierId,
  responsible_party_id: table.responsiblePartyId,
  is_warranty: table.isWarranty,
  start_date: table.startDate,
  expected_completion_date: table.expectedCompletionDate,
  completed_at: table.completedAt,
  completed_by: table.completedBy,
  duration_days: table.assetMaintenanceTime,
  cost: table.cost,
  notes: table.notes,
  url: table.url,
};

export const MaintenanceQuery = z.object({
  asset_id: InventoryIdSchema.optional(),
  state: z.enum(['open', 'completed']).optional(),
});

@Injectable()
export class MaintenanceService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(FmcsScopeService) private readonly fmcs: FmcsScopeService,
    @Inject(HardwareService) private readonly hardware: HardwareService,
  ) {}

  private visible(scope: FmcsScope) {
    return and(
      isNull(table.deletedAt),
      eq(table.itemType, 'asset'),
      sql`exists (select 1 from ${assets} where ${assets.id} = ${table.itemId}
        and ${this.hardware.visible(scope)})`,
    );
  }

  private async find(db: InventoryDatabase, scope: FmcsScope, id: number, lock = false) {
    const query = db
      .select(fields)
      .from(table)
      .where(and(eq(table.id, id), this.visible(scope)));
    const [row] = await (lock ? query.for('update') : query);
    if (!row) throw new NotFoundException('Maintenance intervention not found');
    return row;
  }

  async list(
    query: DatatableQuery & z.output<typeof MaintenanceQuery>,
    user: AuthenticatedUserContext,
    url: string,
  ) {
    requireInventoryPermission(user, 'assets.view');
    return inventoryPage(
      this.db,
      table,
      fields,
      and(
        this.visible(await this.fmcs.resolve(user)),
        query.asset_id === undefined ? undefined : eq(table.itemId, query.asset_id),
        query.state === 'open'
          ? isNull(table.completedAt)
          : query.state === 'completed'
            ? isNotNull(table.completedAt)
            : undefined,
        query.search ? contains(table.name, query.search) : undefined,
      ),
      [query.order === 'asc' ? asc(table.startDate) : desc(table.startDate), desc(table.id)],
      query,
      url,
    );
  }

  async get(id: number, user: AuthenticatedUserContext) {
    requireInventoryPermission(user, 'assets.view');
    return this.find(this.db, await this.fmcs.resolve(user), id);
  }

  async save(body: unknown, user: AuthenticatedUserContext, id?: number) {
    requireInventoryPermission(user, 'assets.edit');
    const input = id === undefined ? MaintenanceInputSchema : MaintenanceInputSchema.partial();
    const dto = parse(input, body);
    return inventoryWrite(this.db, async (tx) => {
      const scope = await this.fmcs.resolve(user, tx);
      const previous = id === undefined ? null : await this.find(tx, scope, id, true);
      if (previous && dto.asset_id !== undefined && dto.asset_id !== previous.asset_id) {
        fieldIssue('asset_id', 'The asset cannot be changed on an existing intervention');
      }
      const asset = await this.hardware.find(tx, scope, dto.asset_id ?? previous!.asset_id, {
        lock: true,
      });
      const start = dto.start_date ?? previous!.start_date;
      const expected =
        dto.expected_completion_date === undefined
          ? previous?.expected_completion_date
          : dto.expected_completion_date;
      if (expected && expected < start)
        fieldIssue('expected_completion_date', 'Expected completion cannot precede the start date');
      if (previous?.completed_at && start > previous.completed_at)
        fieldIssue('start_date', 'Start date cannot follow completion');
      const [type] = await tx
        .select()
        .from(maintenanceTypes)
        .where(
          and(
            eq(maintenanceTypes.id, dto.maintenance_type_id ?? previous!.maintenance_type_id ?? 0),
            isNull(maintenanceTypes.deletedAt),
          ),
        );
      if (!type && (!previous || dto.maintenance_type_id !== undefined))
        fieldIssue('maintenance_type_id', 'Maintenance type is unavailable');
      if (dto.supplier_id != null) await activeReference(tx, suppliers, dto.supplier_id);
      if (dto.responsible_party_id != null)
        await activeReference(
          tx,
          users,
          dto.responsible_party_id,
          this.fmcs.predicate(scope, 'users', users.id),
        );
      const changes = {
        itemId: asset.id,
        maintenanceTypeId: type?.id,
        assetMaintenanceType: type?.name ?? previous!.maintenance_type,
        name: dto.name ?? previous!.name,
        startDate: start,
        expectedCompletionDate: dto.expected_completion_date,
        isWarranty: dto.is_warranty,
        supplierId: dto.supplier_id,
        responsiblePartyId: dto.responsible_party_id,
        cost: dto.cost,
        notes: dto.notes,
        url: dto.url,
        updatedAt: new Date(),
        assetMaintenanceTime: previous?.completed_at
          ? daysBetween(start, previous.completed_at)
          : undefined,
      };
      const [row] =
        id === undefined
          ? await tx
              .insert(table)
              .values({
                ...changes,
                createdBy: user.id,
                checkedOutToId: asset.assignedTo,
                checkedOutToType: asset.assignedType,
              })
              .returning(fields)
          : await tx.update(table).set(changes).where(eq(table.id, id)).returning(fields);
      await writeInventoryLog(tx, {
        itemType: 'maintenance',
        itemId: row!.id,
        targetType: 'asset',
        targetId: asset.id,
        companyId: asset.companyId,
        actionType: previous ? 'update' : 'create',
        createdBy: user.id,
      });
      return success(row!);
    });
  }

  async change(
    id: number,
    action: 'complete' | 'delete' | 'note added',
    body: unknown,
    user: AuthenticatedUserContext,
  ) {
    requireInventoryPermission(user, 'assets.edit');
    const dto = parse(MaintenanceChangeSchema, body ?? {});
    if (action === 'note added' && !dto.note) fieldIssue('note', 'Enter a note');
    return inventoryWrite(this.db, async (tx) => {
      const scope = await this.fmcs.resolve(user, tx);
      const row = await this.find(tx, scope, id, true);
      const asset = await this.hardware.find(tx, scope, row.asset_id);
      let result = row;
      if (action === 'complete') {
        if (row.completed_at) throw new ConflictException('Maintenance is already complete');
        const today = new Date().toISOString().slice(0, 10);
        const date = dto.completed_at ?? today;
        if (date < row.start_date || date > today)
          fieldIssue('completed_at', 'Completion must be between the start date and today');
        [result] = (await tx
          .update(table)
          .set({
            completedAt: date,
            completedBy: user.id,
            assetMaintenanceTime: daysBetween(row.start_date, date),
            updatedAt: new Date(),
          })
          .where(eq(table.id, id))
          .returning(fields)) as [typeof row];
      } else if (action === 'delete') {
        await tx
          .update(table)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(table.id, id));
      }
      await writeInventoryLog(tx, {
        itemType: 'maintenance',
        itemId: id,
        actionType: action === 'complete' ? 'maintenance complete' : action,
        createdBy: user.id,
        targetType: 'asset',
        targetId: asset.id,
        companyId: asset.companyId,
        note: dto.note,
      });
      return success(result);
    });
  }

  async history(
    id: number,
    query: DatatableQuery,
    user: AuthenticatedUserContext,
    url: string,
    notes = false,
  ) {
    requireInventoryPermission(user, 'assets.view');
    const scope = await this.fmcs.resolve(user);
    await this.find(this.db, scope, id);
    return actionHistory(
      this.db,
      'maintenance',
      id,
      query,
      url,
      user,
      and(
        notes ? eq(actionLogs.actionType, 'note added') : undefined,
        this.fmcs.predicate(scope, 'history', actionLogs.id, actionLogs.companyId),
      ),
    );
  }

  async typeList(query: DatatableQuery, user: AuthenticatedUserContext, url: string) {
    requireInventoryPermission(user, 'assets.view');
    return inventoryPage(
      this.db,
      maintenanceTypes,
      {
        id: maintenanceTypes.id,
        name: maintenanceTypes.name,
        is_system: maintenanceTypes.isSystem,
      },
      and(
        isNull(maintenanceTypes.deletedAt),
        query.search ? contains(maintenanceTypes.name, query.search) : undefined,
      ),
      [asc(maintenanceTypes.name), asc(maintenanceTypes.id)],
      query,
      url,
    );
  }

  async typeOptions(query: SelectlistQuery, user: AuthenticatedUserContext) {
    requireInventoryPermission(user, 'assets.view');
    const filter = and(
      isNull(maintenanceTypes.deletedAt),
      query.search ? contains(maintenanceTypes.name, query.search) : undefined,
    );
    const [[total], rows] = await Promise.all([
      this.db.select({ value: count() }).from(maintenanceTypes).where(filter),
      this.db
        .select({ id: maintenanceTypes.id, text: maintenanceTypes.name })
        .from(maintenanceTypes)
        .where(filter)
        .orderBy(maintenanceTypes.name, maintenanceTypes.id)
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
    ]);
    return selectlist(
      total!.value,
      rows.map((row) => ({ ...row, image: null, tag_color: null })),
      query,
    );
  }

  async readType(id: number, user: AuthenticatedUserContext) {
    requireInventoryPermission(user, 'assets.view');
    const [row] = await this.db
      .select({
        id: maintenanceTypes.id,
        name: maintenanceTypes.name,
        is_system: maintenanceTypes.isSystem,
      })
      .from(maintenanceTypes)
      .where(and(eq(maintenanceTypes.id, id), isNull(maintenanceTypes.deletedAt)));
    if (!row) throw new NotFoundException('Maintenance type not found');
    return row;
  }

  async saveType(body: unknown, user: AuthenticatedUserContext, id?: number, remove = false) {
    if (!user.isSuperUser) throw new ForbiddenException('Superuser access required');
    const dto = remove ? null : parse(MaintenanceTypeInputSchema, body);
    return inventoryWrite(this.db, async (tx) => {
      if (id !== undefined) {
        const [type] = await tx
          .select()
          .from(maintenanceTypes)
          .where(and(eq(maintenanceTypes.id, id), isNull(maintenanceTypes.deletedAt)))
          .for('update');
        if (!type) throw new NotFoundException('Maintenance type not found');
        if (type.isSystem)
          throw new ConflictException('Built-in maintenance types are managed by the system');
        if (remove) {
          const [reference] = await tx
            .select({ id: table.id })
            .from(table)
            .where(eq(table.maintenanceTypeId, id))
            .limit(1);
          if (reference) throw new ConflictException('Maintenance type is used by an intervention');
          await tx
            .update(maintenanceTypes)
            .set({ deletedAt: new Date() })
            .where(eq(maintenanceTypes.id, id));
          return success({ id });
        }
      }
      const [duplicate] = await tx
        .select({ id: maintenanceTypes.id })
        .from(maintenanceTypes)
        .where(
          and(
            sql`lower(${maintenanceTypes.name}) = lower(${dto!.name})`,
            isNull(maintenanceTypes.deletedAt),
          ),
        );
      if (duplicate && duplicate.id !== id)
        fieldIssue('name', 'A maintenance type with this name already exists');
      const [row] =
        id === undefined
          ? await tx.insert(maintenanceTypes).values({ name: dto!.name }).returning()
          : await tx
              .update(maintenanceTypes)
              .set({ name: dto!.name, updatedAt: new Date() })
              .where(eq(maintenanceTypes.id, id))
              .returning();
      return success(row!);
    });
  }
}

function daysBetween(start: string, end: string) {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86400000);
}

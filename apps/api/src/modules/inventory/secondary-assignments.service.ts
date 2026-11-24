import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InventoryAssignmentSchema,
  InventoryIdSchema,
  InventoryIdsSchema,
  StockAdjustmentSchema,
  assignmentQuantity,
  inventoryNote,
  type AuthenticatedUserContext,
  type CheckoutTargetType,
  type DatatableQuery,
  type SecondaryResource,
} from '@kestrel-it/shared';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { permitsEntity } from '../../common/guards/permissions.guard.js';
import type { EnvConfig } from '../../config/env.schema.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import {
  accessoriesCheckout,
  actionLogs,
  assets,
  categories,
  checkoutAcceptances,
  companyUser,
  componentsAssets,
  consumablesUsers,
  licenseSeats,
  locations,
  suppliers,
  users,
} from '../../db/schema/index.js';
import { recordAcquisition } from './acquisitions.js';
import { fieldIssue } from './custom-fields-validation.service.js';
import { FmcsScopeService, type FmcsScope } from './fmcs-scope.service.js';
import { scopedAssignmentTarget } from './inventory-visibility.js';
import { InventoryMailService } from './inventory-mail.service.js';
import {
  inventoryWrite,
  parse,
  success,
  type InventoryDatabase,
  type InventoryTransaction,
} from './inventory-queries.js';
import {
  activeReference,
  currentSettings,
  inventoryPage,
  requireInventoryPermission,
  writeInventoryLog,
} from './phase-three-queries.js';
import {
  SecondaryCatalogService,
  secondaryTables,
  secondaryTypes,
} from './secondary-catalog.service.js';

type Assignment = z.output<typeof InventoryAssignmentSchema>;
type StockItem = Awaited<ReturnType<SecondaryCatalogService['find']>>;
type Person = { id: number; email: string | null };
const returnSchema = z.object({
  assignment_id: InventoryIdSchema.optional(),
  accessory_checkout_id: InventoryIdSchema.optional(),
  seat_id: InventoryIdSchema.optional(),
  quantity: assignmentQuantity.optional(),
  note: inventoryNote,
});

export function liveAcceptance() {
  return and(
    isNull(checkoutAcceptances.deletedAt),
    isNull(checkoutAcceptances.acceptedAt),
    isNull(checkoutAcceptances.declinedAt),
  );
}

@Injectable()
export class SecondaryAssignmentsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(FmcsScopeService) private readonly fmcs: FmcsScopeService,
    @Inject(SecondaryCatalogService) private readonly catalog: SecondaryCatalogService,
    @Inject(InventoryMailService) private readonly mail: InventoryMailService,
    @Inject(ConfigService) private readonly env: ConfigService<EnvConfig, true>,
  ) {}

  async assignments(
    resource: SecondaryResource,
    id: number,
    query: DatatableQuery,
    user: AuthenticatedUserContext,
    url: string,
  ) {
    requireInventoryPermission(user, `${resource}.view`);
    const scope = await this.fmcs.resolve(user);
    await this.catalog.find(this.db, resource, scope, id);
    if (resource === 'licenses') {
      return inventoryPage(
        this.db,
        licenseSeats,
        {
          id: licenseSeats.id,
          assigned_to: scopedAssignmentTarget(this.fmcs, scope, user, 'user', licenseSeats.assignedTo),
          asset_id: scopedAssignmentTarget(this.fmcs, scope, user, 'asset', licenseSeats.assetId),
          occupied: sql<boolean>`(${licenseSeats.assignedTo} is not null or ${licenseSeats.assetId} is not null)`,
          unreassignable_seat: licenseSeats.unreassignableSeat,
          note: licenseSeats.notes,
        },
        and(eq(licenseSeats.licenseId, id), isNull(licenseSeats.deletedAt)),
        [asc(licenseSeats.id)],
        query,
        url,
      );
    }
    if (resource === 'accessories') {
      return inventoryPage(
        this.db,
        accessoriesCheckout,
        {
          id: accessoriesCheckout.id,
          target_type: accessoriesCheckout.assignedType,
          target_id: sql<number | null>`case
          when ${accessoriesCheckout.assignedType} = 'user' then ${scopedAssignmentTarget(this.fmcs, scope, user, 'user', accessoriesCheckout.assignedTo)}
          when ${accessoriesCheckout.assignedType} = 'asset' then ${scopedAssignmentTarget(this.fmcs, scope, user, 'asset', accessoriesCheckout.assignedTo)}
          when ${accessoriesCheckout.assignedType} = 'location' then ${scopedAssignmentTarget(this.fmcs, scope, user, 'location', accessoriesCheckout.assignedTo)}
          end`,
          note: accessoriesCheckout.note,
        },
        eq(accessoriesCheckout.accessoryId, id),
        [asc(accessoriesCheckout.id)],
        query,
        url,
      );
    }
    if (resource === 'consumables') {
      return inventoryPage(
        this.db,
        consumablesUsers,
        {
          id: consumablesUsers.id,
          assigned_to: scopedAssignmentTarget(this.fmcs, scope, user, 'user', consumablesUsers.assignedTo),
          consumed_at: consumablesUsers.consumedAt,
          note: consumablesUsers.note,
        },
        eq(consumablesUsers.consumableId, id),
        [asc(consumablesUsers.id)],
        query,
        url,
      );
    }
    return inventoryPage(
      this.db,
      componentsAssets,
      {
        id: componentsAssets.id,
        asset_id: scopedAssignmentTarget(this.fmcs, scope, user, 'asset', componentsAssets.assetId),
        quantity: componentsAssets.assignedQty,
        note: componentsAssets.note,
      },
      eq(componentsAssets.componentId, id),
      [asc(componentsAssets.id)],
      query,
      url,
    );
  }

  async seat(licenseId: number, seatId: number, user: AuthenticatedUserContext) {
    requireInventoryPermission(user, 'licenses.view');
    const scope = await this.fmcs.resolve(user);
    await this.catalog.find(this.db, 'licenses', scope, licenseId);
    const [seat] = await this.db
      .select({
        id: licenseSeats.id,
        assignedTo: scopedAssignmentTarget(this.fmcs, scope, user, 'user', licenseSeats.assignedTo),
        assetId: scopedAssignmentTarget(this.fmcs, scope, user, 'asset', licenseSeats.assetId),
        occupied: sql<boolean>`(${licenseSeats.assignedTo} is not null or ${licenseSeats.assetId} is not null)`,
        unreassignableSeat: licenseSeats.unreassignableSeat,
        notes: licenseSeats.notes,
      })
      .from(licenseSeats)
      .where(
        and(
          eq(licenseSeats.id, seatId),
          eq(licenseSeats.licenseId, licenseId),
          isNull(licenseSeats.deletedAt),
        ),
      );
    if (!seat) throw new NotFoundException('License seat not found');
    return {
      id: seat.id,
      license_id: licenseId,
      assigned_to: seat.assignedTo,
      asset_id: seat.assetId,
      occupied: seat.occupied,
      unreassignable_seat: seat.unreassignableSeat,
      note: seat.notes,
    };
  }

  async target(
    db: InventoryDatabase,
    scope: FmcsScope,
    companyId: number | null,
    type: CheckoutTargetType,
    id: number,
  ): Promise<Person | null> {
    if (type === 'user') {
      const [person] = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(
          and(
            eq(users.id, id),
            isNull(users.deletedAt),
            or(eq(users.activated, true), eq(users.inventoryOnly, true)),
            this.fmcs.predicate(scope, 'users', users.id),
          ),
        );
      if (!person) throw new NotFoundException('Checkout target not found');
      const memberships = await db
        .select({ id: companyUser.companyId })
        .from(companyUser)
        .where(eq(companyUser.userId, id));
      if (
        !this.fmcs.compatible(
          scope,
          companyId,
          memberships.map((row) => row.id),
        )
      ) {
        fieldIssue('target_id', 'Target company is incompatible');
      }
      return person;
    }
    const table = type === 'asset' ? assets : locations;
    const [target] = await db
      .select({ id: table.id, companyId: table.companyId })
      .from(table)
      .where(
        and(
          eq(table.id, id),
          isNull(table.deletedAt),
          this.fmcs.predicate(
            scope,
            type === 'location' ? 'locations' : 'hardware',
            table.id,
            table.companyId,
          ),
        ),
      );
    if (!target) throw new NotFoundException('Checkout target not found');
    if (
      (type !== 'location' || scope.scopeLocations) &&
      !this.fmcs.compatible(scope, companyId, target.companyId === null ? [] : [target.companyId])
    ) {
      fieldIssue('target_id', 'Target company is incompatible');
    }
    return null;
  }

  async checkout(
    resource: SecondaryResource,
    id: number,
    body: unknown,
    user: AuthenticatedUserContext,
  ) {
    const dto = parse(InventoryAssignmentSchema, body);
    return inventoryWrite(this.db, async (tx) =>
      success(
        await this.checkoutInTransaction(
          tx,
          resource,
          id,
          dto,
          user,
          await this.fmcs.resolve(user, tx),
        ),
      ),
    );
  }

  async checkoutInTransaction(
    tx: InventoryTransaction,
    resource: SecondaryResource,
    id: number,
    dto: Assignment,
    user: AuthenticatedUserContext,
    scope: FmcsScope,
  ) {
    requireInventoryPermission(user, `${resource}.checkout`, true);
    const item = await this.catalog.find(tx, resource, scope, id, true);
    if (item.archived) throw new ConflictException('Inventory is archived');
    if (
      (resource === 'components' && dto.target_type !== 'asset') ||
      (resource === 'consumables' && dto.target_type !== 'user') ||
      (resource === 'licenses' && dto.target_type === 'location')
    ) {
      fieldIssue('target_type', 'Target type is unavailable for this inventory');
    }
    const target = await this.target(tx, scope, item.company_id, dto.target_type, dto.target_id);
    const config = await currentSettings(tx);
    if (config?.requireCheckinoutNotes && !dto.note)
      fieldIssue('note', 'A checkout note is required');
    let assignmentIds: number[];
    if (resource === 'licenses') {
      assignmentIds = await this.assignSeats(tx, item, dto, user, scope);
    } else {
      if (item.qty! - item.used < dto.quantity)
        throw new ConflictException('Insufficient available inventory');
      assignmentIds = await this.allocateStock(tx, resource, id, dto, user.id);
    }
    const [category] =
      item.category_id === null
        ? []
        : await tx
            .select()
            .from(categories)
            .where(and(eq(categories.id, item.category_id), isNull(categories.deletedAt)));
    const acceptances: number[] = [];
    const itemType = secondaryTypes[resource];
    for (const assignmentId of assignmentIds) {
      const acceptance =
        target && category?.requireAcceptance
          ? await this.createAcceptance(
              tx,
              resource,
              item,
              assignmentId,
              target,
              user,
              category.eulaText ??
                (category.useDefaultEula ? config?.defaultEulaText : null) ??
                null,
              category.alertOnResponse,
            )
          : null;
      if (acceptance !== null) acceptances.push(acceptance);
      await writeInventoryLog(tx, {
        itemType,
        itemId: id,
        actionType: 'checkout',
        createdBy: user.id,
        companyId: item.company_id,
        targetType: dto.target_type,
        targetId: dto.target_id,
        note: dto.note,
        acceptedId: acceptance,
        quantity: resource === 'components' ? dto.quantity : 1,
        logMeta: { assignment_id: assignmentId },
      });
    }
    const links = acceptances.map(
      (acceptanceId) => new URL(`/account/accept/${acceptanceId}`, this.env.get('APP_URL', { infer: true })).href,
    );
    const shouldEmail = category?.requireAcceptance || category?.checkinEmail ||
      (category?.useDefaultEula ? config?.defaultEulaText : category?.eulaText);
    await this.mail.lifecycle(tx, {
      event: `checkout.${itemType}`, companyId: item.company_id,
      alertOnResponse: acceptances.length > 0,
      recipient: shouldEmail ? target?.email ?? await this.mail.emailRecipient(tx,dto.target_type,dto.target_id) : null,
      subject: `Inventory checked out: ${item.name}`,
      message: `${item.name} was assigned to you.${links.length ? '\nReview and respond:\n' + links.join('\n') : ''}`,
    });
    return { id, assignment_ids: assignmentIds, acceptance_ids: acceptances };
  }

  private async assignSeats(
    tx: InventoryTransaction,
    item: StockItem,
    dto: Assignment,
    user: AuthenticatedUserContext,
    scope: FmcsScope,
  ) {
    if (dto.seat_id && dto.quantity !== 1)
      fieldIssue('quantity', 'An explicit seat can only be checked out once');
    const candidate = dto.seat_id
      ? eq(licenseSeats.id, dto.seat_id)
      : and(isNull(licenseSeats.assignedTo), isNull(licenseSeats.assetId));
    const selected = await tx
      .select()
      .from(licenseSeats)
      .where(and(eq(licenseSeats.licenseId, item.id), isNull(licenseSeats.deletedAt), candidate))
      .orderBy(licenseSeats.unreassignableSeat, licenseSeats.id)
      .limit(dto.quantity)
      .for('update');
    if (selected.length !== dto.quantity || selected.some((seat) => seat.unreassignableSeat)) {
      throw new ConflictException('Insufficient available license seats');
    }
    const [asset] =
      dto.target_type === 'asset'
        ? await tx
            .select({ assignedTo: assets.assignedTo, assignedType: assets.assignedType })
            .from(assets)
            .where(eq(assets.id, dto.target_id))
        : [];
    const assignedUser =
      dto.target_type === 'user'
        ? dto.target_id
        : asset?.assignedType === 'user'
          ? asset.assignedTo
          : null;
    if (assignedUser !== null && dto.target_type === 'asset')
      await this.target(tx, scope, item.company_id, 'user', assignedUser);
    for (const seat of selected) {
      if (seat.assetId !== null || seat.assignedTo !== null) {
        if (!dto.reassign || !item.reassignable)
          throw new ConflictException('License seat cannot be reassigned');
        requireInventoryPermission(user, 'licenses.checkin', true);
        await this.retireAcceptance(tx, 'licenses', item.id, seat.id);
        await this.returnLog(
          tx,
          'licenses',
          item,
          user.id,
          seat.assetId === null ? 'user' : 'asset',
          seat.assetId ?? seat.assignedTo,
          dto.note,
          1,
          seat.id,
        );
      }
      await tx
        .update(licenseSeats)
        .set({
          assignedTo: assignedUser,
          assetId: dto.target_type === 'asset' ? dto.target_id : null,
          notes: dto.note,
          updatedAt: new Date(),
        })
        .where(eq(licenseSeats.id, seat.id));
    }
    return selected.map((seat) => seat.id);
  }

  private async allocateStock(
    tx: InventoryTransaction,
    resource: Exclude<SecondaryResource, 'licenses'>,
    id: number,
    dto: Assignment,
    actor: number,
  ) {
    const common = { note: dto.note, createdBy: actor };
    if (resource === 'components') {
      const rows = await tx
        .insert(componentsAssets)
        .values({
          ...common,
          componentId: id,
          assetId: dto.target_id,
          assignedQty: dto.quantity,
        })
        .returning({ id: componentsAssets.id });
      return rows.map((row) => row.id);
    }
    const quantity = Array.from({ length: dto.quantity }, () => ({
      ...common,
      assignedTo: dto.target_id,
    }));
    if (resource === 'accessories') {
      const rows = await tx
        .insert(accessoriesCheckout)
        .values(quantity.map((row) => ({ ...row, accessoryId: id, assignedType: dto.target_type })))
        .returning({ id: accessoriesCheckout.id });
      return rows.map((row) => row.id);
    }
    const rows = await tx
      .insert(consumablesUsers)
      .values(quantity.map((row) => ({ ...row, consumableId: id })))
      .returning({ id: consumablesUsers.id });
    return rows.map((row) => row.id);
  }

  private async createAcceptance(
    tx: InventoryTransaction,
    resource: SecondaryResource,
    item: StockItem,
    assignmentId: number,
    target: Person,
    user: AuthenticatedUserContext,
    eula: string | null,
    alert: boolean,
  ) {
    const [row] = await tx
      .insert(checkoutAcceptances)
      .values({
        checkoutableType: resource === 'licenses' ? 'license_seat' : secondaryTypes[resource],
        checkoutableId: resource === 'licenses' ? assignmentId : item.id,
        assignedToId: target.id,
        qty: 1,
        storedEula: eula,
        alertOnResponse: alert,
        alertOnResponseId: user.id,
      })
      .returning({ id: checkoutAcceptances.id });
    return row!.id;
  }

  private async retireAcceptance(
    tx: InventoryTransaction,
    resource: SecondaryResource,
    itemId: number,
    assignmentId: number,
  ) {
    const filter =
      resource === 'licenses'
        ? and(
            eq(checkoutAcceptances.checkoutableType, 'license_seat'),
            eq(checkoutAcceptances.checkoutableId, assignmentId),
          )
        : sql`exists (select 1 from ${actionLogs} where ${actionLogs.acceptedId} = ${checkoutAcceptances.id}
          and ${actionLogs.itemType} = ${secondaryTypes[resource]} and ${actionLogs.itemId} = ${itemId}
          and ${actionLogs.actionType} = 'checkout' and ${actionLogs.logMeta}->>'assignment_id' = ${String(assignmentId)})`;
    await tx
      .update(checkoutAcceptances)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(filter, liveAcceptance()));
  }

  private async returnLog(
    tx: InventoryTransaction,
    resource: SecondaryResource,
    item: StockItem,
    actor: number,
    targetType: CheckoutTargetType,
    targetId: number | null,
    note: string | null | undefined,
    quantity: number,
    assignmentId: number,
  ) {
    await writeInventoryLog(tx, {
      itemType: secondaryTypes[resource],
      itemId: item.id,
      createdBy: actor,
      companyId: item.company_id,
      actionType: 'checkin from',
      targetType,
      targetId,
      note,
      quantity,
      logMeta: { assignment_id: assignmentId },
    });
    const [category] = item.category_id === null ? [] : await tx.select().from(categories)
      .where(and(eq(categories.id,item.category_id),isNull(categories.deletedAt)));
    if (resource === 'consumables') return;
    const type = { licenses:'license', accessories:'accessory', components:'component' } as const;
    await this.mail.lifecycle(tx, {
      event: `checkin.${type[resource]}`, companyId:item.company_id,
      recipient:category?.checkinEmail ? await this.mail.emailRecipient(tx,targetType,targetId) : null,
      subject:`Inventory checked in: ${item.name}`, message:`${quantity} × ${item.name} checked in.`,
    });
  }

  async checkin(
    resource: SecondaryResource,
    id: number,
    body: unknown,
    user: AuthenticatedUserContext,
  ) {
    if (resource === 'consumables') throw new NotFoundException('Consumables cannot be checked in');
    requireInventoryPermission(user, `${resource}.checkin`, true);
    const dto = parse(returnSchema, body);
    return inventoryWrite(this.db, async (tx) => {
      const scope = await this.fmcs.resolve(user, tx);
      if ((await currentSettings(tx))?.requireCheckinoutNotes && !dto.note)
        fieldIssue('note', 'A check-in note is required');
      if (resource === 'licenses') {
        const seatId = parse(InventoryIdSchema, dto.seat_id ?? dto.assignment_id);
        const item = await this.catalog.find(tx, resource, scope, id, true);
        const [seat] = await tx
          .select()
          .from(licenseSeats)
          .where(
            and(
              eq(licenseSeats.id, seatId),
              eq(licenseSeats.licenseId, id),
              isNull(licenseSeats.deletedAt),
            ),
          )
          .for('update');
        if (!seat) throw new NotFoundException('License seat not found');
        if (seat.assetId === null && seat.assignedTo === null)
          throw new ConflictException('Seat is already checked in');
        await this.retireAcceptance(tx, resource, id, seatId);
        await tx
          .update(licenseSeats)
          .set({
            assetId: null,
            assignedTo: null,
            notes: dto.note,
            unreassignableSeat: seat.unreassignableSeat || !item.reassignable,
            updatedAt: new Date(),
          })
          .where(eq(licenseSeats.id, seatId));
        await this.returnLog(
          tx,
          resource,
          item,
          user.id,
          seat.assetId === null ? 'user' : 'asset',
          seat.assetId ?? seat.assignedTo,
          dto.note,
          1,
          seatId,
        );
        return success({ id, assignment_id: seatId, quantity: 1 });
      }
      if (resource === 'accessories') {
        const assignmentId = parse(
          InventoryIdSchema,
          dto.accessory_checkout_id ?? dto.assignment_id,
        );
        const item = await this.catalog.find(tx, resource, scope, id, true);
        const [row] = await tx
          .select()
          .from(accessoriesCheckout)
          .where(
            and(eq(accessoriesCheckout.id, assignmentId), eq(accessoriesCheckout.accessoryId, id)),
          )
          .for('update');
        if (!row) throw new NotFoundException('Accessory assignment not found');
        await this.retireAcceptance(tx, resource, id, assignmentId);
        await tx.delete(accessoriesCheckout).where(eq(accessoriesCheckout.id, assignmentId));
        await this.returnLog(
          tx,
          resource,
          item,
          user.id,
          row.assignedType,
          row.assignedTo,
          dto.note,
          1,
          assignmentId,
        );
        return success({ id, assignment_id: assignmentId, quantity: 1 });
      }
      const [row] = await tx
        .select()
        .from(componentsAssets)
        .where(eq(componentsAssets.id, id))
        .for('update');
      if (!row) throw new NotFoundException('Component assignment not found');
      const item = await this.catalog.find(tx, resource, scope, row.componentId, true);
      const quantity = dto.quantity ?? row.assignedQty;
      if (quantity > row.assignedQty)
        fieldIssue('quantity', 'Return cannot exceed assigned quantity');
      if (quantity === row.assignedQty)
        await tx.delete(componentsAssets).where(eq(componentsAssets.id, id));
      else
        await tx
          .update(componentsAssets)
          .set({ assignedQty: row.assignedQty - quantity, updatedAt: new Date() })
          .where(eq(componentsAssets.id, id));
      await this.returnLog(
        tx,
        resource,
        item,
        user.id,
        'asset',
        row.assetId,
        dto.note,
        quantity,
        id,
      );
      return success({ id: item.id, assignment_id: id, quantity });
    });
  }

  async consume(ids: number[], user: AuthenticatedUserContext, itemId?: number) {
    requireInventoryPermission(user, 'consumables.checkout', true);
    const uniqueIds = parse(InventoryIdsSchema, ids);
    return inventoryWrite(this.db, async (tx) => {
      const rows = await tx
        .select()
        .from(consumablesUsers)
        .where(inArray(consumablesUsers.id, uniqueIds))
        .orderBy(consumablesUsers.id)
        .for('update');
      const id = itemId ?? rows[0]?.consumableId;
      if (
        id === undefined ||
        rows.length !== uniqueIds.length ||
        rows.some((row) => row.consumableId !== id)
      ) {
        throw new NotFoundException('Consumable assignments not found for one inventory record');
      }
      const item = await this.catalog.find(
        tx,
        'consumables',
        await this.fmcs.resolve(user, tx),
        id,
        true,
      );
      let consumed = 0;
      for (const row of rows) {
        if (row.consumedAt) continue;
        await tx
          .update(consumablesUsers)
          .set({ consumedAt: new Date(), updatedAt: new Date() })
          .where(eq(consumablesUsers.id, row.id));
        await this.retireAcceptance(tx, 'consumables', id, row.id);
        await writeInventoryLog(tx, {
          itemType: 'consumable',
          itemId: id,
          createdBy: user.id,
          companyId: item.company_id,
          actionType: 'consumed',
          targetType: 'user',
          targetId: row.assignedTo,
          logMeta: { assignment_id: row.id },
        });
        consumed++;
      }
      return success({ consumed });
    });
  }

  async adjust(
    resource: SecondaryResource,
    id: number,
    body: unknown,
    user: AuthenticatedUserContext,
  ) {
    return inventoryWrite(this.db, (tx) => this.adjustInTransaction(tx,resource,id,body,user));
  }

  async adjustInTransaction(tx: InventoryTransaction, resource: SecondaryResource, id: number,
    body: unknown, user: AuthenticatedUserContext, source: 'api'|'importer' = 'api') {
    if (resource === 'licenses') throw new NotFoundException('Use seat management for licenses');
    requireInventoryPermission(user, `${resource}.edit`);
    const dto = parse(StockAdjustmentSchema, body);
      const item = await this.catalog.find(
        tx,
        resource,
        await this.fmcs.resolve(user, tx),
        id,
        true,
      );
      if (item.archived) throw new ConflictException('Inventory is archived');
      const config = await currentSettings(tx);
      if (config?.requireAdjustQuantityNotes && !dto.note)
        fieldIssue('note', 'An adjustment reason is required');
      const qty = item.qty! + dto.amount;
      if (qty < item.used || qty > 2147483647)
        fieldIssue('amount', 'Quantity must cover all allocated units and fit the stock range');
      const table = secondaryTables[resource];
      let lineId: number | null = null;
      if (
        dto.amount > 0 &&
        (dto.order_number ||
          dto.supplier_id ||
          dto.unit_cost != null ||
          dto.currency ||
          dto.purchase_date)
      ) {
        if (dto.supplier_id != null) await activeReference(tx, suppliers, dto.supplier_id);
        const number = dto.order_number;
        if (!number)
          fieldIssue('order_number', 'Order number is required for acquisition metadata');
        lineId = await recordAcquisition(tx, {
          number,
          companyId: item.company_id,
          supplierId: dto.supplier_id,
          itemType: secondaryTypes[resource],
          itemId: id,
          quantity: dto.amount,
          unitCost: dto.unit_cost,
          currency: dto.currency ?? config?.defaultCurrency,
          purchaseDate: dto.purchase_date,
          createdBy: user.id,
        });
      }
      await tx.update(table).set({ qty, updatedAt: new Date() }).where(eq(table.id, id));
      await writeInventoryLog(tx, {
        itemType: secondaryTypes[resource],
        itemId: id,
        actionType: 'adjust quantity',
        actionSource: source,
        createdBy: user.id,
        companyId: item.company_id,
        quantity: dto.amount,
        note: dto.note,
        orderItemId: lineId,
        logMeta: { qty: { old: item.qty, new: qty } },
      });
      return success({ id, qty, remaining: qty - item.used, order_item_id: lineId });
  }
}

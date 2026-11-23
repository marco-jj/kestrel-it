import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  InventoryIdSchema,
  assignmentQuantity,
  inventoryName,
  inventoryNote,
  type AuthenticatedUserContext,
  type DatatableQuery,
  type KitResource,
} from '@kestrel-it/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { permitsEntity } from '../../common/guards/permissions.guard.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import {
  assets,
  kits,
  kitsAccessories,
  kitsConsumables,
  kitsLicenses,
  kitsModels,
  models,
  statusLabels,
} from '../../db/schema/index.js';
import { AssetCheckoutService } from './asset-checkout.service.js';
import { FmcsScopeService, type FmcsScope } from './fmcs-scope.service.js';
import {
  contains,
  inventoryWrite,
  parse,
  success,
  type InventoryDatabase,
} from './inventory-queries.js';
import { inventoryPage, requireInventoryPermission } from './phase-three-queries.js';
import { SecondaryAssignmentsService } from './secondary-assignments.service.js';
import { SecondaryCatalogService, secondaryTables } from './secondary-catalog.service.js';

const members = {
  models: { pivot: kitsModels, item: kitsModels.modelId, table: models },
  licenses: { pivot: kitsLicenses, item: kitsLicenses.licenseId, table: secondaryTables.licenses },
  accessories: {
    pivot: kitsAccessories,
    item: kitsAccessories.accessoryId,
    table: secondaryTables.accessories,
  },
  consumables: {
    pivot: kitsConsumables,
    item: kitsConsumables.consumableId,
    table: secondaryTables.consumables,
  },
} as const;
const kinds = ['models', 'licenses', 'accessories', 'consumables'] as const;
const kitSchema = z.object({ name: inventoryName });

@Injectable()
export class PredefinedKitsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(FmcsScopeService) private readonly fmcs: FmcsScopeService,
    @Inject(SecondaryCatalogService) private readonly catalog: SecondaryCatalogService,
    @Inject(SecondaryAssignmentsService) private readonly workflows: SecondaryAssignmentsService,
    @Inject(AssetCheckoutService) private readonly hardware: AssetCheckoutService,
  ) {}

  private visibility(scope: FmcsScope) {
    return and(
      ...kinds.map((kind) => {
        const { pivot, item, table } = members[kind];
        const target =
          kind === 'models' ? isNull(models.deletedAt) : this.catalog.visible(kind, scope);
        return sql`not exists (select 1 from ${pivot}
        where ${pivot.kitId} = ${kits.id} and not exists
          (select 1 from ${table} where ${eq(item, table.id)} and ${target}))`;
      }),
    );
  }

  private async find(db: InventoryDatabase, id: number, scope: FmcsScope, lock = false) {
    const query = db
      .select()
      .from(kits)
      .where(and(eq(kits.id, id), this.visibility(scope)));
    const [kit] = await (lock ? query.for('update') : query);
    if (!kit) throw new NotFoundException('Kit not found');
    return kit;
  }

  async list(query: DatatableQuery, user: AuthenticatedUserContext, url: string) {
    requireInventoryPermission(user, 'kits.view');
    const scope = await this.fmcs.resolve(user);
    return inventoryPage(
      this.db,
      kits,
      { id: kits.id, name: kits.name },
      and(this.visibility(scope), query.search ? contains(kits.name, query.search) : undefined),
      [query.order === 'desc' ? sql`${kits.name} desc` : asc(kits.name), asc(kits.id)],
      query,
      url,
    );
  }

  async get(id: number, user: AuthenticatedUserContext) {
    requireInventoryPermission(user, 'kits.view');
    return this.find(this.db, id, await this.fmcs.resolve(user));
  }

  async save(body: unknown, user: AuthenticatedUserContext, id?: number) {
    requireInventoryPermission(user, id === undefined ? 'kits.create' : 'kits.edit');
    const dto = parse(kitSchema, body);
    return inventoryWrite(this.db, async (tx) => {
      if (id === undefined)
        return success(
          (
            await tx
              .insert(kits)
              .values({ ...dto, createdBy: user.id })
              .returning()
          )[0]!,
        );
      await this.find(tx, id, await this.fmcs.resolve(user, tx), true);
      return success(
        (
          await tx
            .update(kits)
            .set({ ...dto, updatedAt: new Date() })
            .where(eq(kits.id, id))
            .returning()
        )[0]!,
      );
    });
  }

  async remove(id: number, user: AuthenticatedUserContext) {
    requireInventoryPermission(user, 'kits.delete');
    return inventoryWrite(this.db, async (tx) => {
      await this.find(tx, id, await this.fmcs.resolve(user, tx), true);
      await tx.delete(kits).where(eq(kits.id, id));
      return success({ id });
    });
  }

  private composition(db: InventoryDatabase, kitId: number, kind: KitResource) {
    const { pivot, item, table } = members[kind];
    return db
      .select({ id: item, name: table.name, quantity: pivot.quantity })
      .from(pivot)
      .innerJoin(table, eq(table.id, item))
      .where(eq(pivot.kitId, kitId))
      .orderBy(item);
  }

  async lines(id: number, kind: KitResource, user: AuthenticatedUserContext) {
    requireInventoryPermission(user, 'kits.view');
    const scope = await this.fmcs.resolve(user);
    await this.find(this.db, id, scope);
    const rows = await this.composition(this.db, id, kind);
    return permitsEntity(user, `${kind}.view`) ? rows : rows.map((row) => ({ ...row, name: null }));
  }

  async changeLine(
    kitId: number,
    kind: KitResource,
    user: AuthenticatedUserContext,
    change: 'add' | 'update' | 'delete',
    body?: unknown,
    id?: number,
  ) {
    requireInventoryPermission(user, 'kits.edit');
    const input =
      change === 'delete'
        ? null
        : parse(
            z.object({
              item_id: InventoryIdSchema.optional(),
              quantity: assignmentQuantity,
            }),
            body,
          );
    const itemId = parse(InventoryIdSchema, id ?? input?.item_id);
    return inventoryWrite(this.db, async (tx) => {
      const scope = await this.fmcs.resolve(user, tx);
      await this.find(tx, kitId, scope, true);
      const { pivot, item, table } = members[kind];
      const filter = and(eq(pivot.kitId, kitId), eq(item, itemId));
      if (change === 'add') {
        requireInventoryPermission(user, `${kind}.view`);
        const [row] = await tx
          .select({ id: table.id })
          .from(table)
          .where(
            and(
              eq(table.id, itemId),
              kind === 'models' ? isNull(models.deletedAt) : this.catalog.visible(kind, scope),
            ),
          );
        if (!row) throw new NotFoundException('Kit inventory not found');
        await tx.execute(sql`insert into ${pivot} (kit_id, ${sql.identifier(item.name)}, quantity)
          values (${kitId}, ${itemId}, ${input!.quantity})`);
      } else {
        const rows =
          change === 'delete'
            ? await tx.delete(pivot).where(filter).returning({ id: pivot.id })
            : await tx
                .update(pivot)
                .set({ quantity: input!.quantity })
                .where(filter)
                .returning({ id: pivot.id });
        if (!rows.length) throw new NotFoundException('Kit line not found');
      }
      return success({ id: itemId, quantity: input?.quantity ?? null });
    });
  }

  async checkout(kitId: number, body: unknown, user: AuthenticatedUserContext) {
    requireInventoryPermission(user, 'kits.view');
    const dto = parse(z.object({ user_id: InventoryIdSchema, note: inventoryNote }), body);
    return inventoryWrite(this.db, async (tx) => {
      const scope = await this.fmcs.resolve(user, tx);
      await this.find(tx, kitId, scope, true);
      const lines = [];
      for (const kind of kinds) {
        const composition = await this.composition(tx, kitId, kind);
        if (!composition.length) continue;
        requireInventoryPermission(
          user,
          kind === 'models' ? 'assets.checkout' : `${kind}.checkout`,
          true,
        );
        for (const item of composition) {
          if (kind !== 'models') {
            lines.push({
              type: kind,
              ...(await this.workflows.checkoutInTransaction(
                tx,
                kind,
                item.id,
                {
                  target_type: 'user',
                  target_id: dto.user_id,
                  quantity: item.quantity,
                  note: dto.note,
                },
                user,
                scope,
              )),
            });
            continue;
          }
          const candidates = await tx
            .select({ id: assets.id, companyId: assets.companyId })
            .from(assets)
            .innerJoin(statusLabels, eq(assets.statusId, statusLabels.id))
            .where(
              and(
                eq(assets.modelId, item.id),
                isNull(assets.assignedTo),
                isNull(assets.deletedAt),
                eq(assets.archived, false),
                isNull(statusLabels.deletedAt),
                eq(statusLabels.deployable, true),
                eq(statusLabels.pending, false),
                eq(statusLabels.archived, false),
                this.fmcs.predicate(scope, 'hardware', assets.id, assets.companyId),
              ),
            )
            .orderBy(assets.id)
            .for('update', { of: assets });
          let allocated = 0;
          for (const asset of candidates) {
            try {
              await this.workflows.target(tx, scope, asset.companyId, 'user', dto.user_id);
            } catch (error) {
              if (error instanceof NotFoundException) throw error;
              if ((error as { getStatus?: () => number }).getStatus?.() === 422) continue;
              throw error;
            }
            lines.push({
              type: 'hardware',
              ...(await this.hardware.checkoutInTransaction(
                tx,
                asset.id,
                { target_type: 'user', target_id: dto.user_id, note: dto.note ?? undefined },
                user,
                scope,
              )),
            });
            if (++allocated === item.quantity) break;
          }
          if (allocated !== item.quantity)
            throw new ConflictException(`Insufficient compatible hardware for model #${item.id}`);
        }
      }
      if (!lines.length) throw new ConflictException('The kit is empty');
      return success({ id: kitId, lines });
    });
  }
}

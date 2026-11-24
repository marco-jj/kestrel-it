import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  InventoryIdsSchema,
  SecondaryCatalogSchemas,
  type AuthenticatedUserContext,
  type DatatableQuery,
  type SecondaryResource,
  type SelectlistQuery,
} from '@kestrel-it/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { permitsEntity, permitsKey } from '../../common/guards/permissions.guard.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import {
  accessories,
  accessoriesCheckout,
  actionLogs,
  categories,
  checkoutRequests,
  companies,
  components,
  componentsAssets,
  consumables,
  consumablesUsers,
  depreciations,
  kitsAccessories,
  kitsConsumables,
  kitsLicenses,
  licenses,
  licenseSeats,
  locations,
  manufacturers,
  suppliers,
} from '../../db/schema/index.js';
import { recordAcquisition } from './acquisitions.js';
import { fieldIssue } from './custom-fields-validation.service.js';
import { FmcsScopeService, type FmcsScope } from './fmcs-scope.service.js';
import {
  contains,
  datatable,
  inventoryWrite,
  pageOffset,
  parse,
  selectlist,
  success,
  type InventoryDatabase,
  type InventoryTransaction,
} from './inventory-queries.js';
import {
  actionHistory,
  activeReference,
  currentSettings,
  requireInventoryPermission,
  writeInventoryLog,
} from './phase-three-queries.js';
import { depreciationValue } from './depreciation.js';

export const secondaryTables = { licenses, accessories, consumables, components };
export const secondaryTypes = {
  licenses: 'license',
  accessories: 'accessory',
  consumables: 'consumable',
  components: 'component',
} as const;

function liveStock(resource: SecondaryResource): SQL<number> {
  if (resource === 'licenses')
    return sql<number>`(select count(*)::int from ${licenseSeats}
    where ${licenseSeats.licenseId} = ${licenses.id} and ${licenseSeats.deletedAt} is null
      and (${licenseSeats.assignedTo} is not null or ${licenseSeats.assetId} is not null))`;
  if (resource === 'consumables')
    return sql<number>`(select count(*)::int from ${consumablesUsers}
    where ${consumablesUsers.consumableId} = ${consumables.id} and ${consumablesUsers.consumedAt} is null)`;
  return usedStock(resource);
}

export function usedStock(resource: SecondaryResource): SQL<number> {
  switch (resource) {
    case 'licenses':
      return sql<number>`(select count(*)::int from ${licenseSeats} where ${licenseSeats.licenseId} = ${licenses.id}
        and ${licenseSeats.deletedAt} is null and (${licenseSeats.assignedTo} is not null or
        ${licenseSeats.assetId} is not null or ${licenseSeats.unreassignableSeat}))`;
    case 'accessories':
      return sql<number>`(select count(*)::int from ${accessoriesCheckout} where ${accessoriesCheckout.accessoryId} = ${accessories.id})`;
    case 'consumables':
      return sql<number>`(select count(*)::int from ${consumablesUsers} where ${consumablesUsers.consumableId} = ${consumables.id})`;
    case 'components':
      return sql<number>`(select coalesce(sum(${componentsAssets.assignedQty}), 0)::int from ${componentsAssets}
        where ${componentsAssets.componentId} = ${components.id})`;
  }
}

type StockRow = {
  id: number;
  name: string;
  company_id: number | null;
  category_id: number | null;
  location_id?: number | null;
  qty?: number;
  seats?: number;
  archived?: boolean;
  deleted_at: string | null;
  reassignable?: boolean;
  used: number;
  live: number;
  [key: string]: unknown;
};

const references = {
  company_id: companies,
  category_id: categories,
  manufacturer_id: manufacturers,
  supplier_id: suppliers,
  default_supplier_id: suppliers,
  depreciation_id: depreciations,
  location_id: locations,
};

@Injectable()
export class SecondaryCatalogService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(FmcsScopeService) private readonly fmcs: FmcsScopeService,
  ) {}

  visible(resource: SecondaryResource, scope: FmcsScope, deleted = false) {
    const table = secondaryTables[resource];
    return and(
      deleted ? isNotNull(table.deletedAt) : isNull(table.deletedAt),
      this.fmcs.predicate(scope, resource, table.id, table.companyId),
    );
  }

  async find(
    db: InventoryDatabase,
    resource: SecondaryResource,
    scope: FmcsScope,
    id: number,
    lock = false,
    deleted = false,
  ) {
    const table = secondaryTables[resource];
    const [row] = await db.execute<StockRow>(sql`
      select ${sql.identifier(resource)}.*, ${usedStock(resource)} as used, ${liveStock(resource)} as live from ${table}
      where ${and(eq(table.id, id), this.visible(resource, scope, deleted))}
      ${lock ? sql`for update` : sql.empty()}
    `);
    if (!row) throw new NotFoundException('Inventory record not found');
    return row;
  }

  async list(
    resource: SecondaryResource,
    query: DatatableQuery & { deleted?: boolean },
    user: AuthenticatedUserContext,
    url: string,
  ) {
    requireInventoryPermission(user, `${resource}.view`);
    if (query.deleted) requireInventoryPermission(user, `${resource}.delete`);
    const scope = await this.fmcs.resolve(user);
    const table = secondaryTables[resource];
    const filter = and(
      this.visible(resource, scope, query.deleted),
      (query.search && contains(table.name, query.search)) || undefined,
    );
    const order = query.order === 'desc' ? desc : asc;
    const sort = query.sort === 'id' ? order(table.id) : order(table.name);
    const [[total], rows] = await Promise.all([
      this.db.select({ value: count() }).from(table).where(filter),
      this.db
        .execute<StockRow>(sql`select ${sql.identifier(resource)}.*, ${usedStock(resource)} as used, ${liveStock(resource)} as live from ${table}
        where ${filter} order by ${sort}, ${table.id} limit ${query.limit} offset ${pageOffset(query)}`),
    ]);
    return datatable(
      total!.value,
      rows.map((row) => this.present(resource, row, user)),
      query,
      url,
    );
  }

  async options(
    resource: SecondaryResource,
    query: SelectlistQuery,
    user: AuthenticatedUserContext,
  ) {
    requireInventoryPermission(user, `${resource}.view`);
    const scope = await this.fmcs.resolve(user);
    const table = secondaryTables[resource];
    const filter = and(
      this.visible(resource, scope),
      resource === 'licenses' ? undefined : eq(secondaryTables[resource].archived, false),
      this.fmcs.selectionPredicate(scope, resource, table.companyId, query.companyId),
      query.search ? contains(table.name, query.search) : undefined,
    );
    const [[total], results] = await Promise.all([
      this.db.select({ value: count() }).from(table).where(filter),
      this.db
        .select({ id: table.id, text: table.name })
        .from(table)
        .where(filter)
        .orderBy(table.name, table.id)
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
    ]);
    return selectlist(
      total!.value,
      results.map((row) => ({ ...row, image: null, tag_color: null })),
      query,
    );
  }

  async get(resource: SecondaryResource, id: number, user: AuthenticatedUserContext) {
    requireInventoryPermission(user, `${resource}.view`);
    const row = await this.find(this.db, resource, await this.fmcs.resolve(user), id);
    const record = this.present(resource, row, user);
    if (resource !== 'licenses' || typeof row.depreciation_id !== 'number' || !row.depreciate)
      return record;
    const [schedule] = await this.db
      .select()
      .from(depreciations)
      .where(eq(depreciations.id, row.depreciation_id));
    return {
      ...record,
      book_value: depreciationValue(
        schedule,
        row.purchase_cost as string | null,
        row.purchase_date as string | null,
        (await currentSettings(this.db))?.depreciationMethod ?? 'default',
        new Date().toISOString().slice(0, 10),
      ),
    };
  }

  async save(
    resource: SecondaryResource,
    body: unknown,
    user: AuthenticatedUserContext,
    id?: number,
  ) {
    requireInventoryPermission(user, `${resource}.${id === undefined ? 'create' : 'edit'}`);
    return inventoryWrite(this.db, async (tx) => {
      const scope = await this.fmcs.resolve(user, tx);
      return success(await this.saveInTransaction(tx, resource, scope, user, body, id));
    });
  }

  async saveInTransaction(
    tx: InventoryTransaction,
    resource: SecondaryResource,
    scope: FmcsScope,
    user: AuthenticatedUserContext,
    body: unknown,
    id?: number,
  ) {
    const schema = SecondaryCatalogSchemas[resource];
    const input: Record<string, unknown> =
      id === undefined ? parse(schema, body) : parse(schema.partial(), body);
    const previous = id === undefined ? undefined : await this.find(tx, resource, scope, id, true);
    if (id === undefined || Object.hasOwn(input, 'company_id')) {
      input.company_id = this.fmcs.assign(scope, input.company_id as number | null | undefined);
    }
    if (
      previous &&
      Object.hasOwn(input, 'company_id') &&
      input.company_id !== previous.company_id &&
      previous.live
    ) {
      throw new ConflictException('Inventory with assignments cannot change company');
    }
    if (resource === 'licenses' && Object.hasOwn(input, 'serial')) {
      requireInventoryPermission(user, 'licenses.keys', true);
    }
    const companyId =
      input.company_id === undefined
        ? (previous?.company_id ?? null)
        : (input.company_id as number | null);
    for (const [field, table] of Object.entries(references)) {
      const reference = input[field];
      if (typeof reference !== 'number') continue;
      const columns = getTableColumns(table);
      await activeReference(
        tx,
        table,
        reference,
        this.fmcs.predicate(
          scope,
          field === 'company_id' ? 'companies' : field === 'location_id' ? 'locations' : field,
          columns.id!,
          'companyId' in columns ? columns.companyId : undefined,
        ),
      );
      if (field === 'category_id') {
        const [category] = await tx
          .select({ type: categories.categoryType })
          .from(categories)
          .where(eq(categories.id, reference));
        if (category?.type !== secondaryTypes[resource])
          fieldIssue(field, 'Category does not match inventory type');
      }
    }
    const locationId = Object.hasOwn(input, 'location_id')
      ? input.location_id
      : previous?.location_id;
    if (scope.enabled && scope.scopeLocations && typeof locationId === 'number') {
      const [location] = await tx
        .select()
        .from(locations)
        .where(and(eq(locations.id, locationId), isNull(locations.deletedAt)));
      if (
        !location ||
        (location.companyId !== null &&
          !this.fmcs.compatible(scope, companyId, [location.companyId]))
      ) {
        fieldIssue('location_id', 'Location is outside the inventory company');
      }
    }
    if (previous && Object.hasOwn(input, 'qty') && input.qty !== previous.qty) {
      fieldIssue('qty', 'Use Adjust quantity to change stock');
    }
    if (previous && input.archived === true && previous.live) {
      throw new ConflictException('Return assigned inventory before archiving');
    }
    const table = secondaryTables[resource];
    const values = Object.entries(input);
    let recordId = id;
    if (recordId === undefined) {
      values.push(['created_by', user.id]);
      const [created] = await tx.execute<{ id: number }>(sql`insert into ${table}
        (${sql.join(
          values.map(([key]) => sql.identifier(key)),
          sql`, `,
        )})
        values (${sql.join(
          values.map(([, value]) => sql`${value}`),
          sql`, `,
        )}) returning id`);
      recordId = created!.id;
    } else if (values.length) {
      await tx.execute(sql`update ${table}
        set ${sql.join(
          values.map(([key, value]) => sql`${sql.identifier(key)} = ${value}`),
          sql`, `,
        )}, updated_at = now()
        where ${eq(table.id, recordId)}`);
    }
    if (resource === 'licenses')
      await this.syncSeats(tx, recordId, Number(input.seats ?? previous?.seats ?? 1), user.id);
    const row = await this.find(tx, resource, scope, recordId);
    const orderNumber = resource === 'licenses' ? row.order_number : row.legacy_order_number;
    const quantity = row.qty ?? row.seats ?? 0;
    const orderItemId =
      id === undefined && quantity > 0 && typeof orderNumber === 'string' && orderNumber.trim()
        ? await recordAcquisition(tx, {
            number: orderNumber.trim(),
            companyId,
            itemType: secondaryTypes[resource],
            itemId: recordId,
            quantity,
            supplierId: (resource === 'licenses' ? row.supplier_id : row.default_supplier_id) as
              number | null,
            unitCost: (resource === 'licenses' ? row.purchase_cost : row.default_purchase_cost) as
              string | null,
            purchaseDate: (resource === 'licenses'
              ? row.purchase_date
              : row.legacy_purchase_date) as string | null,
            currency: (await currentSettings(tx))?.defaultCurrency,
            createdBy: user.id,
          })
        : undefined;
    await writeInventoryLog(tx, {
      itemType: secondaryTypes[resource],
      itemId: recordId,
      companyId,
      createdBy: user.id,
      orderItemId,
      actionType: id === undefined ? 'create' : 'update',
    });
    return this.present(resource, row, user);
  }

  private async syncSeats(tx: InventoryTransaction, id: number, requested: number, actor: number) {
    const active = await tx
      .select()
      .from(licenseSeats)
      .where(and(eq(licenseSeats.licenseId, id), isNull(licenseSeats.deletedAt)))
      .orderBy(desc(licenseSeats.id))
      .for('update');
    const delta = requested - active.length;
    if (delta > 0) {
      await tx
        .insert(licenseSeats)
        .values(Array.from({ length: delta }, () => ({ licenseId: id, createdBy: actor })));
    }
    if (delta < 0) {
      const removable = active.filter(
        (seat) => seat.assignedTo === null && seat.assetId === null && !seat.unreassignableSeat,
      );
      if (removable.length < -delta)
        fieldIssue('seats', 'Assigned and retired seats cannot be removed');
      for (const seat of removable.slice(0, -delta)) {
        await tx
          .update(licenseSeats)
          .set({ deletedAt: new Date() })
          .where(eq(licenseSeats.id, seat.id));
      }
    }
  }

  async archiveAction(
    resource: SecondaryResource,
    id: number,
    action: 'delete' | 'restore' | 'unarchive',
    user: AuthenticatedUserContext,
  ) {
    return this.bulk(resource, action, { ids: [id] }, user);
  }

  async bulk(
    resource: SecondaryResource,
    action: 'edit' | 'delete' | 'restore' | 'unarchive',
    body: unknown,
    user: AuthenticatedUserContext,
  ) {
    requireInventoryPermission(
      user,
      `${resource}.${action === 'edit' || action === 'unarchive' ? 'edit' : 'delete'}`,
    );
    const { ids, changes } = parse(
      z.object({ ids: InventoryIdsSchema, changes: z.unknown().optional() }),
      body,
    );
    return inventoryWrite(this.db, async (tx) => {
      const scope = await this.fmcs.resolve(user, tx);
      const table = secondaryTables[resource];
      for (const id of ids.sort((a, b) => a - b)) {
        if (action === 'edit') {
          await this.saveInTransaction(tx, resource, scope, user, changes ?? {}, id);
          continue;
        }
        const row = await this.find(tx, resource, scope, id, true, action === 'restore');
        if (action === 'delete') {
          if (row.live) throw new ConflictException('Inventory still has assignments');
          const kitTable = {
            licenses: kitsLicenses,
            accessories: kitsAccessories,
            consumables: kitsConsumables,
          }[resource as 'licenses' | 'accessories' | 'consumables'];
          if (kitTable) {
            const column = sql.identifier(`${secondaryTypes[resource]}_id`);
            const [kit] = await tx.execute(
              sql`select id from ${kitTable} where ${column} = ${id} limit 1`,
            );
            if (kit) throw new ConflictException('Inventory is included in a kit');
          }
          const [pendingRequest] = await tx
            .select({ id: checkoutRequests.id })
            .from(checkoutRequests)
            .where(
              and(
                eq(checkoutRequests.requestableType, secondaryTypes[resource]),
                eq(checkoutRequests.requestableId, id),
                eq(checkoutRequests.state, 'pending'),
                isNull(checkoutRequests.deletedAt),
              ),
            )
            .limit(1);
          if (pendingRequest)
            throw new ConflictException('Inventory has pending checkout requests');
        }
        if (action === 'unarchive') {
          if (resource === 'licenses')
            throw new NotFoundException('Archive is unavailable for licenses');
          await tx
            .update(secondaryTables[resource])
            .set({ archived: false, updatedAt: new Date() })
            .where(eq(table.id, id));
        } else {
          await tx
            .update(table)
            .set({ deletedAt: action === 'delete' ? new Date() : null, updatedAt: new Date() })
            .where(eq(table.id, id));
        }
        await writeInventoryLog(tx, {
          itemType: secondaryTypes[resource],
          itemId: id,
          companyId: row.company_id,
          actionType: action === 'unarchive' ? 'update' : action,
          createdBy: user.id,
        });
      }
      return success({ ids });
    });
  }

  async history(
    resource: SecondaryResource,
    id: number,
    query: DatatableQuery,
    user: AuthenticatedUserContext,
    url: string,
  ) {
    requireInventoryPermission(user, `${resource}.view`);
    const scope = await this.fmcs.resolve(user);
    await this.find(this.db, resource, scope, id, false, false);
    return actionHistory(
      this.db,
      secondaryTypes[resource],
      id,
      query,
      url,
      user,
      this.fmcs.predicate(scope, resource, actionLogs.id, actionLogs.companyId),
    );
  }

  private present(resource: SecondaryResource, row: StockRow, user: AuthenticatedUserContext) {
    const { used, live, ...item } = row;
    const total = Number(item.qty ?? item.seats);
    const remaining = Math.max(0, total - used);
    if (resource === 'licenses' && !permitsKey(user, 'licenses.keys')) item.serial = null;
    return {
      ...item,
      id: row.id,
      name: row.name,
      display_name: row.name,
      remaining,
      assigned_count: live,
      available_actions: row.deleted_at
        ? { restore: permitsEntity(user, `${resource}.delete`) }
        : {
            view: true,
            update: permitsEntity(user, `${resource}.edit`),
            delete: permitsEntity(user, `${resource}.delete`) && live === 0,
            checkout: !row.archived && remaining > 0 && permitsKey(user, `${resource}.checkout`),
            checkin:
              resource !== 'consumables' && live > 0 && permitsKey(user, `${resource}.checkin`),
          },
    };
  }
}

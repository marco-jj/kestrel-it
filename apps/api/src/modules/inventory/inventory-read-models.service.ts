import type { InventoryDatabase } from './inventory-queries.js';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  InventoryIdSchema,
  SECONDARY_RESOURCES,
  type AuthenticatedUserContext,
  type DatatableQuery,
} from '@kestrel-it/shared';
import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { permitsEntity, permitsKey } from '../../common/guards/permissions.guard.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import {
  assetMaintenances,
  assets,
  calendarEvents,
  checkoutRequests,
  consumablesUsers,
  licenses,
  models,
  orderItems,
  orders,
  statusLabels,
  suppliers,
  users,
} from '../../db/schema/index.js';
import { fieldIssue } from './custom-fields-validation.service.js';
import { FmcsScopeService, type FmcsScope } from './fmcs-scope.service.js';
import { HardwareService } from './hardware.service.js';
import { contains, datatable, pageOffset } from './inventory-queries.js';
import {
  activeReference,
  currentSettings,
  requireInventoryPermission,
} from './phase-three-queries.js';
import {
  SecondaryCatalogService,
  secondaryTables,
  secondaryTypes,
  usedStock,
} from './secondary-catalog.service.js';
import { addCalendarMonths } from './depreciation.js';

const eventTypes = [
  'asset.audit_due',
  'asset.expected_checkin',
  'asset.checkout',
  'asset.eol',
  'asset.warranty_expiration',
  'maintenance.start',
  'license.expiration',
  'license.termination',
  'user.start_date',
  'user.end_date',
  'request.reservation',
] as const;
const iso = z.union([z.string().date(), z.string().datetime({ offset: true })]);
export const CalendarQuerySchema = z.object({
  start: iso.optional(),
  end: iso.optional(),
  event_type: z
    .union([z.string().transform((value) => value.split(',')), z.array(z.string())])
    .pipe(z.array(z.enum(eventTypes)))
    .optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .transform((value) => Math.min(500, value))
    .default(500),
});
export const OrderQuerySchema = z.object({
  item_type: z.enum(['asset', 'license', 'accessory', 'consumable', 'component']).optional(),
  item_id: InventoryIdSchema.optional(),
  asset_model_id: InventoryIdSchema.optional(),
});
const labels: Record<(typeof eventTypes)[number], string> = {
  'asset.audit_due': 'Audit due',
  'asset.expected_checkin': 'Expected check-in',
  'asset.checkout': 'Checkout',
  'asset.eol': 'End of life',
  'asset.warranty_expiration': 'Warranty expiry',
  'maintenance.start': 'Maintenance',
  'license.expiration': 'License expiry',
  'license.termination': 'License termination',
  'user.start_date': 'User start',
  'user.end_date': 'User end',
  'request.reservation': 'Reservation',
};
const sourceLinks: Record<string, string> = {
  asset: '/hardware',
  license: '/licenses',
  maintenance: '/maintenances',
  user: '/users',
  checkout_request: '/requests',
};

@Injectable()
export class InventoryReadModelsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(FmcsScopeService) private readonly fmcs: FmcsScopeService,
    @Inject(HardwareService) private readonly hardware: HardwareService,
    @Inject(SecondaryCatalogService) private readonly catalog: SecondaryCatalogService,
  ) {}

  async calendar(query: z.output<typeof CalendarQuerySchema>, user: AuthenticatedUserContext) {
    const scope = await this.fmcs.resolve(user);
    const now = new Date();
    const start = new Date(query.start ?? addCalendarMonths(now, -3));
    const end = new Date(query.end ?? addCalendarMonths(now, 3));
    if (start >= end) fieldIssue('end', 'End must follow start');
    const canAssets = permitsEntity(user, 'assets.view');
    const canLicenses = permitsEntity(user, 'licenses.view');
    const canUsers = permitsEntity(user, 'users.view');
    const canRequests = permitsKey(user, 'assets.checkout');
    if (!canAssets && !canLicenses && !canUsers && !canRequests)
      throw new ForbiddenException('Calendar access required');
    const source = calendarEvents.sourceId;
    const branches: SQL[] = [];
    const selection = (kind: string, name: SQL, from: SQL, predicate: SQL | undefined) => sql`
      select ${calendarEvents.id}, ${calendarEvents.sourceType}, ${source}, ${calendarEvents.sourceField},
        ${calendarEvents.eventType}, ${calendarEvents.start}, ${calendarEvents.end}, ${name} as name
      from ${calendarEvents} join ${from}
      where ${and(
        eq(calendarEvents.sourceType, kind as typeof calendarEvents.$inferSelect.sourceType),
        isNull(calendarEvents.deletedAt),
        sql`${calendarEvents.start} < ${end.toISOString()}::timestamptz and
          (${calendarEvents.start} >= ${start.toISOString()}::timestamptz or ${calendarEvents.end} > ${start.toISOString()}::timestamptz)`,
        query.event_type?.length
          ? sql`${calendarEvents.eventType} in (${sql.join(
              query.event_type.map((type) => sql`${type}`),
              sql`, `,
            )})`
          : undefined,
        predicate,
      )}`;
    if (canAssets) {
      branches.push(
        selection(
          'asset',
          sql`coalesce(${assets.assetTag}, ${assets.name})`,
          sql`${assets} on ${assets.id} = ${source}`,
          this.hardware.visible(scope),
        ),
      );
      branches.push(
        selection(
          'maintenance',
          sql`${assetMaintenances.name}`,
          sql`${assetMaintenances} on ${assetMaintenances.id} = ${source}
          join ${assets} on ${assets.id} = ${assetMaintenances.itemId}`,
          and(
            isNull(assetMaintenances.deletedAt),
            eq(assetMaintenances.itemType, 'asset'),
            this.hardware.visible(scope),
          ),
        ),
      );
    }
    if (canLicenses)
      branches.push(
        selection(
          'license',
          sql`${licenses.name}`,
          sql`${licenses} on ${licenses.id} = ${source}`,
          this.catalog.visible('licenses', scope),
        ),
      );
    if (canUsers)
      branches.push(
        selection(
          'user',
          sql`coalesce(${users.displayName}, ${users.username})`,
          sql`${users} on ${users.id} = ${source}`,
          and(isNull(users.deletedAt), this.fmcs.predicate(scope, 'users', users.id)),
        ),
      );
    if (canRequests) {
      const canAccessories = permitsEntity(user, 'accessories.view');
      const canConsumables = permitsEntity(user, 'consumables.view');
      const canComponents = permitsEntity(user, 'components.view');
      branches.push(
        selection(
          'checkout_request',
          sql`coalesce(${assets.assetTag}, ${models.name}, ${licenses.name},
            ${secondaryTables.accessories.name}, ${secondaryTables.consumables.name}, ${secondaryTables.components.name})`,
          sql`${checkoutRequests} on ${checkoutRequests.id} = ${source}
          join ${users} on ${users.id} = ${checkoutRequests.userId}
          left join ${assets} on ${assets.id} = ${checkoutRequests.requestableId}
            and ${checkoutRequests.requestableType} = 'asset'
          left join ${models} on ${models.id} = ${checkoutRequests.requestableId}
            and ${checkoutRequests.requestableType} = 'model'
          left join ${licenses} on ${licenses.id} = ${checkoutRequests.requestableId}
            and ${checkoutRequests.requestableType} = 'license'
          left join ${secondaryTables.accessories} on ${secondaryTables.accessories.id} = ${checkoutRequests.requestableId}
            and ${checkoutRequests.requestableType} = 'accessory'
          left join ${secondaryTables.consumables} on ${secondaryTables.consumables.id} = ${checkoutRequests.requestableId}
            and ${checkoutRequests.requestableType} = 'consumable'
          left join ${secondaryTables.components} on ${secondaryTables.components.id} = ${checkoutRequests.requestableId}
            and ${checkoutRequests.requestableType} = 'component'`,
          and(
            isNull(checkoutRequests.deletedAt),
            isNull(users.deletedAt),
            this.fmcs.predicate(scope, 'users', users.id),
            or(
              canAssets
                ? and(sql`${assets.id} is not null`, this.hardware.visible(scope))
                : undefined,
              permitsEntity(user, 'models.view')
                ? and(sql`${models.id} is not null`, isNull(models.deletedAt))
                : undefined,
              canLicenses
                ? and(sql`${licenses.id} is not null`, this.catalog.visible('licenses', scope))
                : undefined,
              canAccessories
                ? and(
                    sql`${secondaryTables.accessories.id} is not null`,
                    this.catalog.visible('accessories', scope),
                  )
                : undefined,
              canConsumables
                ? and(
                    sql`${secondaryTables.consumables.id} is not null`,
                    this.catalog.visible('consumables', scope),
                  )
                : undefined,
              canComponents
                ? and(
                    sql`${secondaryTables.components.id} is not null`,
                    this.catalog.visible('components', scope),
                  )
                : undefined,
              sql`false`,
            ),
          ),
        ),
      );
    }
    const union = sql.join(branches, sql` union all `);
    const [totals, rows] = await Promise.all([
      this.db.execute<{ total: number }>(
        sql`select count(*)::int as total from (${union}) as events`,
      ),
      this.db.execute<{
        id: number;
        source_type: string;
        source_id: number;
        source_field: string;
        event_type: (typeof eventTypes)[number];
        start: string;
        end: string | null;
        name: string | null;
      }>(sql`select * from (${union}) as events order by start, id limit ${query.limit}`),
    ]);
    const total = totals[0]!.total;
    return {
      total,
      truncated: total > rows.length,
      events: rows.map((row) => {
        const allDay = row.event_type !== 'asset.checkout';
        const isoDate = (value: string) => {
          const converted = new Date(value).toISOString();
          return allDay ? converted.slice(0, 10) : converted;
        };
        const base = sourceLinks[row.source_type]!;
        const url =
          row.source_type === 'checkout_request' || row.source_type === 'user'
            ? base
            : `${base}?detail=${row.source_id}`;
        return {
          id: row.id,
          title: `${labels[row.event_type]} · ${row.name ?? '#' + row.source_id}`,
          start: isoDate(row.start),
          end: row.end ? isoDate(row.end) : null,
          allDay,
          url,
          extendedProps: {
            source_type: row.source_type,
            source_id: row.source_id,
            source_field: row.source_field,
            event_type: row.event_type,
          },
        };
      }),
    };
  }

  async acquisitionLines(
    query: DatatableQuery & z.output<typeof OrderQuerySchema>,
    user: AuthenticatedUserContext,
    url: string,
  ) {
    const scope = await this.fmcs.resolve(user);
    const { item_type: type, item_id: id, asset_model_id: modelId } = query;
    if (
      (type === undefined) !== (id === undefined) ||
      (modelId !== undefined && id !== undefined)
    ) {
      fieldIssue('item_id', 'Provide one item type and ID, or an asset model ID');
    }
    let parentScope = this.parentInventory(scope);
    if (modelId !== undefined) {
      requireInventoryPermission(user, 'models.view');
      requireInventoryPermission(user, 'assets.view');
      await activeReference(this.db, models, modelId);
      parentScope = sql`${orderItems.itemType} = 'asset' and exists (select 1 from ${assets}
        where ${assets.id} = ${orderItems.itemId} and ${assets.modelId} = ${modelId} and ${this.hardware.visible(scope)})`;
    } else if (id !== undefined && type) {
      if (type === 'asset') {
        requireInventoryPermission(user, 'assets.view');
        await this.hardware.find(this.db, scope, id);
      } else {
        const kind = SECONDARY_RESOURCES.find((resource) => secondaryTypes[resource] === type);
        if (!kind) throw new NotFoundException('Inventory parent not found');
        requireInventoryPermission(user, `${kind}.view`);
        await this.catalog.find(this.db, kind, scope, id);
      }
      parentScope = and(eq(orderItems.itemType, type), eq(orderItems.itemId, id));
    } else if (!user.isSuperUser) {
      throw new ForbiddenException('Unfiltered acquisition history requires superuser access');
    }
    const filters = and(
      parentScope,
      isNull(orders.deletedAt),
      isNull(orderItems.deletedAt),
      this.fmcs.predicate(scope, 'orders', orders.id, orders.companyId),
      query.search
        ? or(contains(orders.orderNumber, query.search), contains(suppliers.name, query.search))
        : undefined,
    );
    const from = sql`from ${orderItems} join ${orders} on ${orders.id} = ${orderItems.orderId}
      left join ${suppliers} on ${suppliers.id} = ${orders.supplierId} where ${filters}`;
    const sort =
      {
        order_number: orders.orderNumber,
        purchase_date: orderItems.purchaseDate,
        unit_cost: orderItems.unitCost,
        quantity: orderItems.quantity,
        supplier: suppliers.name,
      }[query.sort ?? ''] ?? orderItems.id;
    const direction = query.order === 'asc' ? sql`asc` : sql`desc`;
    const [totals, rows] = await Promise.all([
      this.db.execute<{ total: number }>(sql`select count(*)::int as total ${from}`),
      this.db
        .execute(sql`select ${orderItems.id}, ${orders.id} as order_id, ${orders.orderNumber}, ${suppliers.name} as supplier,
        ${orderItems.itemType}, ${orderItems.itemId}, ${orderItems.quantity}, ${orderItems.unitCost},
        ${orderItems.currency}, coalesce(${orderItems.purchaseDate}, ${orders.purchaseDate}) as purchase_date
        ${from} order by ${sort} ${direction} nulls last, ${orderItems.id} desc limit ${query.limit} offset ${pageOffset(query)}`),
    ]);
    return datatable(totals[0]!.total, Array.from(rows), query, url);
  }

  private parentInventory(scope: FmcsScope) {
    return or(
      sql`${orderItems.itemType} = 'asset' and exists (select 1 from ${assets}
        where ${assets.id} = ${orderItems.itemId} and ${this.hardware.visible(scope)})`,
      ...SECONDARY_RESOURCES.map(
        (kind) => sql`${orderItems.itemType} = ${secondaryTypes[kind]} and exists
        (select 1 from ${secondaryTables[kind]} where ${secondaryTables[kind].id} = ${orderItems.itemId}
          and ${this.catalog.visible(kind, scope)})`,
      ),
    );
  }

  async lowStock(query: DatatableQuery, user: AuthenticatedUserContext, url: string, db: InventoryDatabase = this.db) {
    const scope = await this.fmcs.resolve(user, db);
    const config = await currentSettings(db);
    const threshold = config?.alertThreshold ?? 5;
    const branches = [];
    for (const kind of SECONDARY_RESOURCES) {
      if (!permitsEntity(user, `${kind}.view`)) continue;
      const table = secondaryTables[kind];
      const total = kind === 'licenses' ? licenses.seats : secondaryTables[kind].qty;
      const used =
        kind === 'consumables'
          ? sql`(select count(*)::int from ${consumablesUsers}
        where ${consumablesUsers.consumableId} = ${table.id} and ${consumablesUsers.consumedAt} is not null)`
          : usedStock(kind);
      branches.push(sql`select ${table.id}, ${table.name}, ${kind}::text as type, ${total} as qty,
        ${table.minAmt}, greatest(0, ${total} - ${used}) as remaining from ${table} where
        ${and(
          this.catalog.visible(kind, scope),
          kind === 'licenses'
            ? sql`${licenses.minAmt} > 0`
            : eq(secondaryTables[kind].archived, false),
        )}`);
    }
    if (permitsEntity(user, 'models.view') && permitsEntity(user, 'assets.view')) {
      branches.push(sql`select ${models.id}, ${models.name}, 'models'::text as type, stock.qty, ${models.minAmt}, stock.remaining
        from ${models} cross join lateral (
          select count(*)::int as qty,
            count(*) filter (where ${assets.assignedTo} is null and not ${assets.archived} and ${statusLabels.deployable} and
              not ${statusLabels.pending} and not ${statusLabels.archived})::int as remaining
          from ${assets} left join ${statusLabels} on ${statusLabels.id} = ${assets.statusId}
            and ${statusLabels.deletedAt} is null
          where ${assets.modelId} = ${models.id} and ${this.hardware.visible(scope)}
        ) as stock where ${models.deletedAt} is null and ${models.minAmt} > 0`);
    }
    if (!branches.length) throw new ForbiddenException('Stock access required');
    const from = sql`from (${sql.join(branches, sql` union all `)}) as stock where remaining::bigint < min_amt::bigint + ${threshold}
      ${query.search ? sql`and ${contains(sql`stock.name`, query.search)}` : sql.empty()}`;
    const column = ['name', 'type', 'qty', 'min_amt', 'remaining', 'percent'].includes(
      query.sort ?? '',
    )
      ? query.sort!
      : 'remaining';
    const direction = query.order === 'desc' ? sql`desc` : sql`asc`;
    const [totals, rows] = await Promise.all([
      db.execute<{ total: number }>(sql`select count(*)::int as total ${from}`),
      db.execute<{ id: number; type: string }>(sql`select stock.*, case when qty > 0 then
        round(100.0 * remaining / qty)::int else 100 end as percent ${from}
        order by ${sql.identifier(column)} ${direction}, type, id limit ${query.limit} offset ${pageOffset(query)}`),
    ]);
    return datatable(
      totals[0]!.total,
      rows.map((row) => ({ ...row, url: `/${row.type}?detail=${row.id}` })),
      query,
      url,
    );
  }
}

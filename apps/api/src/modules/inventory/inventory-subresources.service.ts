import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  type AuthenticatedUserContext,
  type DatatableQuery,
} from '@kestrel-it/shared';
import { and, asc, count, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { permitsEntity, permitsKey } from '../../common/guards/permissions.guard.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import {
  accessories,
  accessoriesCheckout,
  actionLogs,
  assets,
  checkoutAcceptances,
  components,
  componentsAssets,
  consumables,
  consumablesUsers,
  licenseSeats,
  licenses,
  locations,
  models,
  statusLabels,
  users,
} from '../../db/schema/index.js';
import { CheckoutAcceptancesService } from './checkout-acceptances.service.js';
import { FmcsScopeService, type FmcsScope } from './fmcs-scope.service.js';
import { HardwareService, assetStatus } from './hardware.service.js';
import { datatable, pageOffset, success } from './inventory-queries.js';
import { SecondaryCatalogService } from './secondary-catalog.service.js';

@Injectable()
export class InventorySubresourcesService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(FmcsScopeService) private readonly fmcs: FmcsScopeService,
    @Inject(HardwareService) private readonly hardware: HardwareService,
    @Inject(SecondaryCatalogService) private readonly secondaryCatalog: SecondaryCatalogService,
    @Inject(CheckoutAcceptancesService) private readonly acceptances: CheckoutAcceptancesService,
  ) {}

  private async ensureUser(scope: FmcsScope, id: number) {
    const [row] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt), this.fmcs.predicate(scope, 'users', users.id)))
      .limit(1);
    if (!row) throw new NotFoundException('User not found');
  }

  private async ensureLocation(scope: FmcsScope, id: number) {
    const [row] = await this.db
      .select({ id: locations.id })
      .from(locations)
      .where(
        and(
          eq(locations.id, id),
          isNull(locations.deletedAt),
          this.fmcs.predicate(scope, 'locations', locations.id, locations.companyId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Location not found');
  }

  async userAssets(
    userId: number,
    query: DatatableQuery,
    actor: AuthenticatedUserContext,
    url: string,
    self = false,
  ) {
    const scope = await this.fmcs.resolve(actor);
    if (!self) await this.ensureUser(scope, userId);
    if (!self && !permitsEntity(actor, 'assets.view')) return datatable(0, [], query, url);
    const filters = and(
      isNull(assets.deletedAt),
      eq(assets.assignedType, 'user'),
      eq(assets.assignedTo, userId),
      self ? undefined : this.hardware.visible(scope),
    );
    const [[total], rows] = await Promise.all([
      this.db.select({ value: count() }).from(assets).where(filters),
      this.db
        .select({ asset: assets, status: statusLabels, fieldsetId: models.fieldsetId })
        .from(assets)
        .leftJoin(
          statusLabels,
          and(eq(statusLabels.id, assets.statusId), isNull(statusLabels.deletedAt)),
        )
        .leftJoin(models, eq(models.id, assets.modelId))
        .where(filters)
        .orderBy(asc(assets.assetTag), asc(assets.id))
        .limit(query.limit)
        .offset(pageOffset(query)),
    ]);
    const sets = [...new Set(rows.map(({ fieldsetId }) => fieldsetId))];
    const fields = new Map(
      await Promise.all(
        sets.map(async (setId) => [setId, await this.hardware.assetFields(this.db, setId)] as const),
      ),
    );
    return datatable(
      total!.value,
      rows.map(({ asset, status, fieldsetId }) =>
        this.hardware.serialize(asset, status, fields.get(fieldsetId) ?? [], actor),
      ),
      query,
      url,
    );
  }

  async userAccessories(
    userId: number,
    query: DatatableQuery,
    actor: AuthenticatedUserContext,
    url: string,
    self = false,
  ) {
    const scope = await this.fmcs.resolve(actor);
    if (!self) await this.ensureUser(scope, userId);
    if (!self && !permitsEntity(actor, 'accessories.view')) return datatable(0, [], query, url);
    const filters = and(
      eq(accessoriesCheckout.assignedType, 'user'),
      eq(accessoriesCheckout.assignedTo, userId),
      isNull(accessories.deletedAt),
      self ? undefined : this.secondaryCatalog.visible('accessories', scope),
    );
    const [[total], rows] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(accessoriesCheckout)
        .innerJoin(accessories, eq(accessories.id, accessoriesCheckout.accessoryId))
        .where(filters),
      this.db
        .select({
          assignmentId: accessoriesCheckout.id,
          id: accessories.id,
          name: accessories.name,
          modelNumber: accessories.modelNumber,
          note: accessoriesCheckout.note,
          checkedOutAt: accessoriesCheckout.createdAt,
        })
        .from(accessoriesCheckout)
        .innerJoin(accessories, eq(accessories.id, accessoriesCheckout.accessoryId))
        .where(filters)
        .orderBy(desc(accessoriesCheckout.id))
        .limit(query.limit)
        .offset(pageOffset(query)),
    ]);
    return datatable(
      total!.value,
      rows.map((row) => ({
        id: row.id,
        assignment_id: row.assignmentId,
        name: row.name,
        model_number: row.modelNumber,
        note: row.note,
        checked_out_at: row.checkedOutAt.toISOString(),
      })),
      query,
      url,
    );
  }

  async userConsumables(
    userId: number,
    query: DatatableQuery,
    actor: AuthenticatedUserContext,
    url: string,
    self = false,
  ) {
    const scope = await this.fmcs.resolve(actor);
    if (!self) await this.ensureUser(scope, userId);
    if (!self && !permitsEntity(actor, 'consumables.view')) return datatable(0, [], query, url);
    const filters = and(
      eq(consumablesUsers.assignedTo, userId),
      isNull(consumables.deletedAt),
      self ? undefined : this.secondaryCatalog.visible('consumables', scope),
    );
    const [[total], rows] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(consumablesUsers)
        .innerJoin(consumables, eq(consumables.id, consumablesUsers.consumableId))
        .where(filters),
      this.db
        .select({
          assignmentId: consumablesUsers.id,
          id: consumables.id,
          name: consumables.name,
          itemNo: consumables.itemNo,
          note: consumablesUsers.note,
          consumedAt: consumablesUsers.consumedAt,
          createdAt: consumablesUsers.createdAt,
        })
        .from(consumablesUsers)
        .innerJoin(consumables, eq(consumables.id, consumablesUsers.consumableId))
        .where(filters)
        .orderBy(desc(consumablesUsers.id))
        .limit(query.limit)
        .offset(pageOffset(query)),
    ]);
    return datatable(
      total!.value,
      rows.map((row) => ({
        id: row.id,
        assignment_id: row.assignmentId,
        name: row.name,
        item_no: row.itemNo,
        note: row.note,
        consumed_at: row.consumedAt?.toISOString() ?? null,
        checked_out_at: row.createdAt.toISOString(),
      })),
      query,
      url,
    );
  }

  async userLicenses(
    userId: number,
    query: DatatableQuery,
    actor: AuthenticatedUserContext,
    url: string,
    self = false,
  ) {
    const scope = await this.fmcs.resolve(actor);
    if (!self) await this.ensureUser(scope, userId);
    if (!self && !permitsEntity(actor, 'licenses.view')) return datatable(0, [], query, url);
    const filters = and(
      eq(licenseSeats.assignedTo, userId),
      isNull(licenseSeats.deletedAt),
      isNull(licenses.deletedAt),
      self ? undefined : this.secondaryCatalog.visible('licenses', scope),
    );
    const canKeys = permitsKey(actor, 'licenses.keys');
    const [[total], rows] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(licenseSeats)
        .innerJoin(licenses, eq(licenses.id, licenseSeats.licenseId))
        .where(filters),
      this.db
        .select({
          seatId: licenseSeats.id,
          id: licenses.id,
          name: licenses.name,
          serial: licenses.serial,
          assetId: licenseSeats.assetId,
          expirationDate: licenses.expirationDate,
          notes: licenseSeats.notes,
        })
        .from(licenseSeats)
        .innerJoin(licenses, eq(licenses.id, licenseSeats.licenseId))
        .where(filters)
        .orderBy(asc(licenses.name), asc(licenseSeats.id))
        .limit(query.limit)
        .offset(pageOffset(query)),
    ]);
    return datatable(
      total!.value,
      rows.map((row) => ({
        id: row.id,
        seat_id: row.seatId,
        name: row.name,
        serial: row.serial === null ? null : canKeys ? row.serial : '***************',
        asset_id: row.assetId,
        expiration_date: row.expirationDate,
        notes: row.notes,
      })),
      query,
      url,
    );
  }

  async userEulas(userId: number, query: DatatableQuery, actor: AuthenticatedUserContext, url: string) {
    const scope = await this.fmcs.resolve(actor);
    await this.ensureUser(scope, userId);
    const filter = and(
      isNull(checkoutAcceptances.deletedAt),
      eq(checkoutAcceptances.assignedToId, userId),
    );
    const source = this.acceptances.subjects(scope, false);
    const from = sql`from ${checkoutAcceptances} join lateral (${source}) as item on true where ${filter}`;
    const [totals, rows] = await Promise.all([
      this.db.execute<{ total: number }>(sql`select count(*)::int as total ${from}`),
      this.db.execute<{
        id: number;
        asset_id: number;
        asset_tag: string | null;
        asset_name: string | null;
        item_type: string;
        state: string;
        accepted_at: string | null;
        declined_at: string | null;
        created_at: string;
        has_eula: boolean;
        has_signature: boolean;
      }>(sql`select ${checkoutAcceptances.id}, item.inventory_id as asset_id, item.tag as asset_tag, item.name as asset_name,
        item.item_type, case when ${checkoutAcceptances.acceptedAt} is not null then 'accepted'
          when ${checkoutAcceptances.declinedAt} is not null then 'declined' else 'pending' end as state,
        ${checkoutAcceptances.acceptedAt}, ${checkoutAcceptances.declinedAt}, ${checkoutAcceptances.createdAt},
        ${checkoutAcceptances.storedEulaFile} is not null as has_eula,
        ${checkoutAcceptances.signatureFilename} is not null as has_signature
        ${from} order by ${checkoutAcceptances.id} desc limit ${query.limit} offset ${pageOffset(query)}`),
    ]);
    return datatable(totals[0]!.total, Array.from(rows), query, url);
  }

  async userHistory(userId: number, query: DatatableQuery, actor: AuthenticatedUserContext, url: string) {
    const scope = await this.fmcs.resolve(actor);
    await this.ensureUser(scope, userId);
    const filters = and(
      isNull(actionLogs.deletedAt),
      or(
        and(eq(actionLogs.itemType, 'user'), eq(actionLogs.itemId, userId)),
        and(eq(actionLogs.targetType, 'user'), eq(actionLogs.targetId, userId)),
        eq(actionLogs.createdBy, userId),
      ),
      this.fmcs.predicate(scope, 'history', actionLogs.id, actionLogs.companyId),
    );
    const [[total], rows] = await Promise.all([
      this.db.select({ value: count() }).from(actionLogs).where(filters),
      this.db
        .select()
        .from(actionLogs)
        .where(filters)
        .orderBy(desc(actionLogs.actionDate), desc(actionLogs.id))
        .limit(query.limit)
        .offset(pageOffset(query)),
    ]);
    return datatable(
      total!.value,
      rows.map((row) => ({
        id: row.id,
        action_type: row.actionType,
        item_type: row.itemType,
        item_id: row.itemId,
        target_type: row.targetType,
        target_id: row.targetId,
        action_date: (row.actionDate ?? row.createdAt).toISOString(),
        note: row.note,
      })),
      query,
      url,
    );
  }

  async accountSummary(query: DatatableQuery, actor: AuthenticatedUserContext, url: string) {
    const [assignedAssets, assignedLicenses, assignedAccessories, assignedConsumables] =
      await Promise.all([
        this.userAssets(actor.id, query, actor, url, true),
        this.userLicenses(actor.id, query, actor, url, true),
        this.userAccessories(actor.id, query, actor, url, true),
        this.userConsumables(actor.id, query, actor, url, true),
      ]);
    return success({
      assets: assignedAssets.rows,
      licenses: assignedLicenses.rows,
      accessories: assignedAccessories.rows,
      consumables: assignedConsumables.rows,
      pagination: {
        current_page: assignedAssets.current_page,
        total_pages: Math.max(
          assignedAssets.total_pages,
          assignedLicenses.total_pages,
          assignedAccessories.total_pages,
          assignedConsumables.total_pages,
        ),
        totals: {
          assets: assignedAssets.total,
          licenses: assignedLicenses.total,
          accessories: assignedAccessories.total,
          consumables: assignedConsumables.total,
        },
      },
    });
  }

  async locationAssets(
    locationId: number,
    query: DatatableQuery,
    actor: AuthenticatedUserContext,
    url: string,
  ) {
    const scope = await this.fmcs.resolve(actor);
    await this.ensureLocation(scope, locationId);
    const filters = and(
      this.hardware.visible(scope),
      or(eq(assets.locationId, locationId), eq(assets.rtdLocationId, locationId)),
    );
    const [[total], rows] = await Promise.all([
      this.db.select({ value: count() }).from(assets).where(filters),
      this.db
        .select({ asset: assets, status: statusLabels, fieldsetId: models.fieldsetId })
        .from(assets)
        .leftJoin(
          statusLabels,
          and(eq(statusLabels.id, assets.statusId), isNull(statusLabels.deletedAt)),
        )
        .leftJoin(models, eq(models.id, assets.modelId))
        .where(filters)
        .orderBy(asc(assets.assetTag), asc(assets.id))
        .limit(query.limit)
        .offset(pageOffset(query)),
    ]);
    const sets = [...new Set(rows.map(({ fieldsetId }) => fieldsetId))];
    const fields = new Map(
      await Promise.all(
        sets.map(async (setId) => [setId, await this.hardware.assetFields(this.db, setId)] as const),
      ),
    );
    return datatable(
      total!.value,
      rows.map(({ asset, status, fieldsetId }) =>
        this.hardware.serialize(asset, status, fields.get(fieldsetId) ?? [], actor),
      ),
      query,
      url,
    );
  }

  async locationAccessories(
    locationId: number,
    query: DatatableQuery,
    actor: AuthenticatedUserContext,
    url: string,
  ) {
    const scope = await this.fmcs.resolve(actor);
    await this.ensureLocation(scope, locationId);
    if (!permitsEntity(actor, 'accessories.view')) return datatable(0, [], query, url);
    const filters = and(
      eq(accessoriesCheckout.assignedType, 'location'),
      eq(accessoriesCheckout.assignedTo, locationId),
      isNull(accessories.deletedAt),
      this.secondaryCatalog.visible('accessories', scope),
    );
    const [[total], rows] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(accessoriesCheckout)
        .innerJoin(accessories, eq(accessories.id, accessoriesCheckout.accessoryId))
        .where(filters),
      this.db
        .select({
          assignmentId: accessoriesCheckout.id,
          id: accessories.id,
          name: accessories.name,
          modelNumber: accessories.modelNumber,
          note: accessoriesCheckout.note,
        })
        .from(accessoriesCheckout)
        .innerJoin(accessories, eq(accessories.id, accessoriesCheckout.accessoryId))
        .where(filters)
        .orderBy(asc(accessories.name), asc(accessoriesCheckout.id))
        .limit(query.limit)
        .offset(pageOffset(query)),
    ]);
    return datatable(
      total!.value,
      rows.map((row) => ({
        id: row.id,
        assignment_id: row.assignmentId,
        name: row.name,
        model_number: row.modelNumber,
        note: row.note,
      })),
      query,
      url,
    );
  }

  async locationComponents(
    locationId: number,
    query: DatatableQuery,
    actor: AuthenticatedUserContext,
    url: string,
  ) {
    const scope = await this.fmcs.resolve(actor);
    await this.ensureLocation(scope, locationId);
    if (!permitsEntity(actor, 'components.view')) return datatable(0, [], query, url);
    const filters = and(
      isNull(components.deletedAt),
      this.secondaryCatalog.visible('components', scope),
      this.hardware.visible(scope),
      eq(assets.locationId, locationId),
    );
    const [[total], rows] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(componentsAssets)
        .innerJoin(components, eq(components.id, componentsAssets.componentId))
        .innerJoin(assets, eq(assets.id, componentsAssets.assetId))
        .where(filters),
      this.db
        .select({
          assignmentId: componentsAssets.id,
          componentId: components.id,
          name: components.name,
          assetId: assets.id,
          assetTag: assets.assetTag,
          assignedQty: componentsAssets.assignedQty,
        })
        .from(componentsAssets)
        .innerJoin(components, eq(components.id, componentsAssets.componentId))
        .innerJoin(assets, eq(assets.id, componentsAssets.assetId))
        .where(filters)
        .orderBy(asc(components.name), asc(componentsAssets.id))
        .limit(query.limit)
        .offset(pageOffset(query)),
    ]);
    return datatable(
      total!.value,
      rows.map((row) => ({
        id: row.componentId,
        assignment_id: row.assignmentId,
        name: row.name,
        asset_id: row.assetId,
        asset_tag: row.assetTag,
        assigned_qty: row.assignedQty,
      })),
      query,
      url,
    );
  }

  async statusCountsByName(actor: AuthenticatedUserContext) {
    const scope = await this.fmcs.resolve(actor);
    const rows = await this.db
      .select({
        id: statusLabels.id,
        name: statusLabels.name,
        color: statusLabels.color,
        deployable: statusLabels.deployable,
        pending: statusLabels.pending,
        archived: statusLabels.archived,
        count: sql<number>`count(${assets.id})::int`,
      })
      .from(statusLabels)
      .leftJoin(assets, and(eq(assets.statusId, statusLabels.id), this.hardware.visible(scope)))
      .where(isNull(statusLabels.deletedAt))
      .groupBy(statusLabels.id)
      .orderBy(asc(statusLabels.name));
    return success(rows);
  }

  async statusCountsByType(actor: AuthenticatedUserContext) {
    const scope = await this.fmcs.resolve(actor);
    const rows = await this.db
      .select({
        asset: assets,
        status: statusLabels,
      })
      .from(assets)
      .leftJoin(
        statusLabels,
        and(eq(statusLabels.id, assets.statusId), isNull(statusLabels.deletedAt)),
      )
      .where(this.hardware.visible(scope));
    const buckets: Record<string, number> = {
      deployable: 0,
      deployed: 0,
      pending: 0,
      archived: 0,
      undeployable: 0,
    };
    for (const row of rows) {
      const key = assetStatus(row.asset, row.status);
      buckets[key] = (buckets[key] ?? 0) + 1;
    }
    return success(buckets);
  }

  async statusDeployable(id: number) {
    const [row] = await this.db
      .select()
      .from(statusLabels)
      .where(and(eq(statusLabels.id, id), isNull(statusLabels.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException('Status label not found');
    const statusType = row.archived
      ? 'archived'
      : row.pending
        ? 'pending'
        : row.deployable
          ? 'deployable'
          : 'undeployable';
    return success({
      id: row.id,
      name: row.name,
      deployable: row.deployable,
      pending: row.pending,
      archived: row.archived,
      status_type: statusType,
    });
  }
}

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AssetInputSchema,
  InventoryBulkSchema,
  type AuthenticatedUserContext,
  type CustomFieldFormMode,
  type HardwareQuery,
  type SelectlistQuery,
} from '@kestrel-it/shared';
import { and, asc, count, desc, eq, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { permitsEntity, permitsKey } from '../../common/guards/permissions.guard.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import {
  actionLogs,
  assets,
  checkoutRequests,
  customFieldDefaults,
  customFields,
  licenseSeats,
  models,
  settings,
  statusLabels,
} from '../../db/schema/index.js';
import { AssetModelsService } from './asset-models.service.js';
import {
  CustomFieldsValidationService,
  fieldIssue,
  type FieldsetEntry,
} from './custom-fields-validation.service.js';
import { DirectoryService } from './directory.service.js';
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

export type Hardware = typeof assets.$inferSelect;
type StatusLabel = typeof statusLabels.$inferSelect;
type HardwareInput = Partial<z.output<typeof AssetInputSchema>>;
const allowedSorts = {
  name: assets.name,
  asset_tag: assets.assetTag,
  serial: assets.serial,
  id: assets.id,
  model_id: assets.modelId,
  company_id: assets.companyId,
  status_id: assets.statusId,
  created_at: assets.createdAt,
  purchase_date: assets.purchaseDate,
  last_checkout: assets.lastCheckout,
  last_checkin: assets.lastCheckin,
  checkout_counter: assets.checkoutCounter,
  checkin_counter: assets.checkinCounter,
} as const;

export function assetStatus(asset: Hardware, status: StatusLabel | null) {
  if (asset.archived || status?.archived) return 'archived';
  if (status?.pending) return 'pending';
  if (!status?.deployable) return 'undeployable';
  return asset.assignedTo === null ? 'deployable' : 'deployed';
}

function formattedDate(raw: Date | string | null) {
  if (raw === null) return null;
  if (typeof raw === 'string') return { date: raw, formatted: raw };
  const datetime = raw.toISOString().slice(0, 19).replace('T', ' ');
  return { datetime, formatted: datetime };
}

@Injectable()
export class HardwareService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(FmcsScopeService) private readonly fmcs: FmcsScopeService,
    @Inject(DirectoryService) private readonly directory: DirectoryService,
    @Inject(AssetModelsService) private readonly modelService: AssetModelsService,
    @Inject(CustomFieldsValidationService)
    private readonly validation: CustomFieldsValidationService,
  ) {}

  visible(scope: FmcsScope, deleted = false) {
    return and(
      deleted ? isNotNull(assets.deletedAt) : isNull(assets.deletedAt),
      this.fmcs.predicate(scope, 'hardware', assets.id, assets.companyId),
    );
  }

  async find(
    db: InventoryDatabase,
    scope: FmcsScope,
    selector: number | string,
    options: {
      deleted?: boolean;
      lock?: boolean;
    } = {},
  ) {
    const query = db
      .select()
      .from(assets)
      .where(
        and(
          typeof selector === 'number' ? eq(assets.id, selector) : eq(assets.assetTag, selector),
          this.visible(scope, options.deleted),
        ),
      )
      .limit(1);
    const [asset] = await (options.lock ? query.for('update') : query);
    if (!asset) throw new NotFoundException('Asset not found');
    return asset;
  }

  async status(db: InventoryDatabase, id: number | null) {
    if (id === null) return null;
    const [status] = await db
      .select()
      .from(statusLabels)
      .where(and(eq(statusLabels.id, id), isNull(statusLabels.deletedAt)))
      .limit(1);
    return status ?? null;
  }

  async get(selector: number | string, user: AuthenticatedUserContext) {
    const row = await this.find(this.db, await this.fmcs.resolve(user), selector);
    const [status, entries] = await Promise.all([
      this.status(this.db, row.statusId),
      this.assetFields(this.db, row.modelId),
    ]);
    return this.serialize(row, status, entries, user);
  }

  async assetFields(db: InventoryDatabase, modelId: number | null) {
    if (modelId === null) return [];
    const [model] = await db
      .select({ fieldsetId: models.fieldsetId })
      .from(models)
      .where(eq(models.id, modelId))
      .limit(1);
    return this.validation.fields(db, model?.fieldsetId ?? null);
  }

  async form(modelId: number, mode: CustomFieldFormMode, user: AuthenticatedUserContext) {
    const model = await this.modelService.find(this.db, modelId);
    const entries = await this.validation.fields(this.db, model.fieldsetId);
    const fields = this.validation.describe(entries, mode);
    if (mode !== 'asset') return { fields, defaults: {} };
    const rows = await this.db
      .select()
      .from(customFieldDefaults)
      .where(eq(customFieldDefaults.modelId, modelId));
    const defaults = new Map(
      rows.map(({ customFieldId, defaultValue }) => [customFieldId, defaultValue]),
    );
    const canDecrypt = permitsKey(user, 'assets.view.encrypted_custom_fields');
    return {
      fields,
      defaults: Object.fromEntries(
        entries
          .filter(({ field }) => defaults.has(field.id))
          .map(({ field }) => [
            field.dbColumn,
            field.fieldEncrypted && !canDecrypt
              ? 'ENCRYPTED'
              : this.validation.decodeDefault(field, defaults.get(field.id)!),
          ]),
      ),
    };
  }

  async options(query: SelectlistQuery, user: AuthenticatedUserContext, modelId?: number) {
    const scope = await this.fmcs.resolve(user);
    const filters = and(
      this.visible(scope),
      modelId === undefined ? undefined : eq(assets.modelId, modelId),
      query.companyId === undefined ? undefined : eq(assets.companyId, query.companyId),
      query.search
        ? or(
            contains(assets.name, query.search),
            contains(assets.assetTag, query.search),
            contains(assets.serial, query.search),
          )
        : undefined,
      query.statusType ? this.statusFilter(query.statusType) : undefined,
    );
    const [[total], rows] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(assets)
        .leftJoin(statusLabels, eq(statusLabels.id, assets.statusId))
        .where(filters),
      this.db
        .select({ id: assets.id, name: assets.name, tag: assets.assetTag, image: assets.image })
        .from(assets)
        .leftJoin(statusLabels, eq(statusLabels.id, assets.statusId))
        .where(filters)
        .orderBy(assets.assetTag, assets.id)
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
    ]);
    return selectlist(
      total!.value,
      rows.map((row) => ({
        id: row.id,
        text: [row.tag, row.name].filter(Boolean).join(' — ') || `Asset #${row.id}`,
        image: row.image,
        tag_color: null,
      })),
      query,
    );
  }

  async list(query: HardwareQuery, user: AuthenticatedUserContext, url: string, modelId?: number) {
    if (query.deleted === '1' && !permitsEntity(user, 'assets.delete'))
      throw new ForbiddenException('Insufficient permissions');
    const scope = await this.fmcs.resolve(user);
    const filters = and(
      await this.filters(query),
      this.visible(scope, query.deleted === '1'),
      modelId === undefined ? undefined : eq(assets.modelId, modelId),
    );
    const order = query.order === 'desc' ? desc : asc;
    const column = Object.hasOwn(allowedSorts, query.sort ?? '')
      ? allowedSorts[query.sort as keyof typeof allowedSorts]
      : assets.assetTag;
    const from = () =>
      this.db
        .select({ asset: assets, status: statusLabels, fieldsetId: models.fieldsetId })
        .from(assets)
        .leftJoin(
          statusLabels,
          and(eq(statusLabels.id, assets.statusId), isNull(statusLabels.deletedAt)),
        )
        .leftJoin(models, eq(models.id, assets.modelId))
        .where(filters);
    const [[total], rows] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(assets)
        .leftJoin(
          statusLabels,
          and(eq(statusLabels.id, assets.statusId), isNull(statusLabels.deletedAt)),
        )
        .leftJoin(models, eq(models.id, assets.modelId))
        .where(filters),
      from().orderBy(order(column), asc(assets.id)).limit(query.limit).offset(pageOffset(query)),
    ]);
    const sets = [...new Set(rows.map(({ fieldsetId }) => fieldsetId))];
    const fields = new Map(
      await Promise.all(
        sets.map(async (id) => [id, await this.validation.fields(this.db, id)] as const),
      ),
    );
    return datatable(
      total!.value,
      rows.map(({ asset, status, fieldsetId }) =>
        this.serialize(asset, status, fields.get(fieldsetId) ?? [], user),
      ),
      query,
      url,
    );
  }

  async customFilterOptions(query: SelectlistQuery) {
    const filters = and(
      eq(customFields.fieldEncrypted, false),
      query.search ? contains(customFields.name, query.search) : undefined,
    );
    const [[total], rows] = await Promise.all([
      this.db.select({ value: count() }).from(customFields).where(filters),
      this.db
        .select({ id: customFields.id, db_column: customFields.dbColumn, name: customFields.name })
        .from(customFields)
        .where(filters)
        .orderBy(customFields.name, customFields.id)
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
    ]);
    return {
      ...selectlist(
        total!.value,
        rows.map(({ id, name }) => ({
          id,
          text: name,
          image: null,
          tag_color: null,
        })),
        query,
      ),
      fields: rows,
    };
  }

  private async filters(query: HardwareQuery) {
    const columns = {
      model_id: assets.modelId,
      company_id: assets.companyId,
      status_id: assets.statusId,
      location_id: assets.locationId,
      rtd_location_id: assets.rtdLocationId,
      manufacturer_id: models.manufacturerId,
      category_id: models.categoryId,
      supplier_id: assets.supplierId,
    } as const;
    const filters: (SQL | undefined)[] = Object.entries(columns).map(([key, column]) => {
      const value = query[key as keyof typeof columns];
      return value === undefined ? undefined : eq(column, value);
    });
    if (query.search)
      filters.push(
        or(
          contains(assets.assetTag, query.search),
          contains(assets.serial, query.search),
          contains(assets.name, query.search),
          contains(models.name, query.search),
        ),
      );
    if (query.tag !== undefined) filters.push(eq(assets.assetTag, query.tag));
    if (query.serial !== undefined) filters.push(eq(assets.serial, query.serial));
    if (query.requestable !== undefined)
      filters.push(eq(assets.requestable, query.requestable === '1'));
    if (query.status !== undefined) filters.push(this.statusFilter(query.status));
    if (query.custom_field !== undefined || query.custom_value !== undefined) {
      await this.validateCustomFilter(query.custom_field, query.custom_value);
      filters.push(sql`${assets.customFields} ->> ${query.custom_field!} = ${query.custom_value!}`);
    }
    return and(...filters);
  }

  async validateCustomFilter(key: string | undefined, value: string | undefined) {
    if (key === undefined && value === undefined) return;
    if (!key || value === undefined) fieldIssue('custom_field', 'Provide a field and a value');
    const [field] = await this.db
      .select({ encrypted: customFields.fieldEncrypted })
      .from(customFields)
      .where(eq(customFields.dbColumn, key))
      .limit(1);
    if (!field || field.encrypted)
      fieldIssue('custom_field', 'This field is unavailable for filtering');
  }

  private statusFilter(status: string): SQL {
    const archived = or(eq(assets.archived, true), eq(statusLabels.archived, true));
    const pending = eq(statusLabels.pending, true);
    const active = and(
      eq(assets.archived, false),
      eq(statusLabels.archived, false),
      eq(statusLabels.pending, false),
    );
    const deployable = and(active, eq(statusLabels.deployable, true));
    switch (status) {
      case 'archived':
        return archived!;
      case 'pending':
        return and(eq(assets.archived, false), eq(statusLabels.archived, false), pending)!;
      case 'deployable':
        return and(deployable, isNull(assets.assignedTo))!;
      case 'deployed':
        return and(deployable, isNotNull(assets.assignedTo))!;
      case 'undeployable':
        return and(
          eq(assets.archived, false),
          or(isNull(statusLabels.id), and(active, eq(statusLabels.deployable, false))),
        )!;
      default:
        return fieldIssue('status', 'Unknown asset status');
    }
  }

  async save(body: unknown, user: AuthenticatedUserContext, id?: number) {
    const dto =
      id === undefined ? parse(AssetInputSchema, body) : parse(AssetInputSchema.partial(), body);
    return inventoryWrite(this.db, async (tx) => {
      const scope = await this.fmcs.resolve(user, tx);
      const current = id === undefined ? undefined : await this.find(tx, scope, id, { lock: true });
      return success(await this.persist(tx, dto, scope, user, current));
    });
  }

  async bulk(input: unknown, user: AuthenticatedUserContext) {
    const dto = parse(InventoryBulkSchema, input);
    if (!permitsEntity(user, dto.action === 'edit' ? 'assets.edit' : 'assets.delete')) {
      throw new ForbiddenException('Insufficient permissions');
    }
    const ids = [...new Set(dto.ids)].sort((a, b) => a - b);
    const changes =
      dto.action === 'edit' ? parse(AssetInputSchema.partial(), dto.changes) : undefined;
    return inventoryWrite(this.db, async (tx) => {
      const scope = await this.fmcs.resolve(user, tx);
      for (const id of ids) {
        const asset = await this.find(tx, scope, id, {
          deleted: dto.action === 'restore',
          lock: true,
        });
        if (changes) await this.persist(tx, changes, scope, user, asset);
        else await this.changeDeleted(tx, scope, asset, user, dto.action === 'restore');
      }
      return success({ ids });
    });
  }

  private async persist(
    tx: InventoryTransaction,
    dto: HardwareInput,
    scope: FmcsScope,
    user: AuthenticatedUserContext,
    current?: Hardware,
  ) {
    const [config] = await tx.select().from(settings).orderBy(settings.id).limit(1).for('update');
    const modelId = dto.model_id ?? current?.modelId;
    if (!modelId) fieldIssue('model_id', 'Choose an asset model');
    const model = await this.modelService.find(tx, modelId);
    const statusId = dto.status_id ?? current?.statusId;
    if (!statusId) fieldIssue('status_id', 'Choose a status label');
    const status = await this.status(tx, statusId);
    if (!status) fieldIssue('status_id', 'Choose an active status label');
    const companyId =
      !current || dto.company_id !== undefined
        ? this.fmcs.assign(scope, dto.company_id)
        : current.companyId;
    if (companyId !== null) await this.directory.reference(tx, scope, 'companies', companyId);
    if (dto.supplier_id != null)
      await this.directory.reference(tx, scope, 'suppliers', dto.supplier_id);
    for (const location of new Set([dto.location_id, dto.rtd_location_id])) {
      if (location != null) {
        const target = await this.directory.reference(tx, scope, 'locations', location);
        const targetCompanyIds = typeof target.companyId === 'number' ? [target.companyId] : [];
        if (scope.scopeLocations && !this.fmcs.compatible(scope, companyId, targetCompanyIds)) {
          fieldIssue('location_id', 'The location is outside the asset company scope');
        }
      }
    }
    if (
      current?.assignedTo != null &&
      (companyId !== current.companyId || dto.location_id !== undefined)
    )
      fieldIssue(
        'company_id',
        'Check in this asset before changing its company or current location',
      );

    const serial = dto.serial !== undefined ? dto.serial || null : (current?.serial ?? null);
    if (model.requireSerial && !serial)
      fieldIssue('serial', 'Serial number is required by this model');
    await this.assertSerial(tx, serial, config?.uniqueSerial ?? false, current?.id);
    let tag = dto.asset_tag !== undefined ? dto.asset_tag : current?.assetTag;
    if (!tag && config?.autoIncrementAssets) tag = await this.nextTag(tx, config);
    if (!tag) fieldIssue('asset_tag', 'Asset tag is required');
    await this.assertTag(tx, tag, current?.id);

    const entries = await this.validation.fields(tx, model.fieldsetId);
    if (current && modelId !== current.modelId) {
      const nextKeys = new Set(entries.map(({ field }) => field.dbColumn));
      if (Object.keys(current.customFields).some((key) => !nextKeys.has(key))) {
        fieldIssue('model_id', 'Clear custom values that are unavailable on the new model first');
      }
    }
    const customFields = await this.validation.prepare(tx, {
      entries,
      submitted: dto.custom_fields,
      existing: current?.customFields,
      assetId: current?.id,
      applyDefaultsFrom: current ? undefined : modelId,
    });
    const changed = {
      name: dto.name,
      assetTag: tag,
      serial,
      modelId,
      statusId,
      companyId,
      supplierId: dto.supplier_id,
      locationId:
        dto.location_id !== undefined
          ? dto.location_id
          : current?.assignedTo == null && dto.rtd_location_id !== undefined
            ? dto.rtd_location_id
            : undefined,
      rtdLocationId: dto.rtd_location_id,
      purchaseDate: dto.purchase_date,
      purchaseCost: dto.purchase_cost,
      orderNumber: dto.order_number,
      warrantyMonths: dto.warranty_months,
      assetEolDate: dto.asset_eol_date,
      requestable: dto.requestable,
      byod: dto.byod,
      notes: dto.notes,
      customFields,
      updatedAt: new Date(),
    };
    const [row] = current
      ? await tx.update(assets).set(changed).where(eq(assets.id, current.id)).returning()
      : await tx
          .insert(assets)
          .values({ ...changed, createdBy: user.id })
          .returning();
    await this.log(tx, row!, user.id, current ? 'update' : 'create');
    return this.serialize(row!, status, entries, user);
  }

  private async nextTag(tx: InventoryTransaction, config: typeof settings.$inferSelect) {
    let next = config.nextAutoTagBase;
    while (next < 2_147_483_647) {
      const tag =
        (config.autoIncrementPrefix ?? '') + String(next).padStart(config.zerofillCount, '0');
      next += 1;
      const [found] = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.assetTag, tag), isNull(assets.deletedAt)))
        .limit(1);
      if (found) continue;
      await tx.update(settings).set({ nextAutoTagBase: next }).where(eq(settings.id, config.id));
      return tag;
    }
    throw new ConflictException('The automatic asset tag counter is exhausted');
  }

  private async assertTag(tx: InventoryTransaction, tag: string, id?: number) {
    const [found] = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(
          isNull(assets.deletedAt),
          eq(assets.assetTag, tag),
          id === undefined ? undefined : ne(assets.id, id),
        ),
      )
      .limit(1);
    if (found) fieldIssue('asset_tag', 'This asset tag is already in use');
  }

  private async assertSerial(
    tx: InventoryTransaction,
    serial: string | null,
    unique: boolean,
    id?: number,
  ) {
    if (!unique || !serial) return;
    const [found] = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(
          isNull(assets.deletedAt),
          eq(assets.serial, serial),
          id === undefined ? undefined : ne(assets.id, id),
        ),
      )
      .limit(1);
    if (found) fieldIssue('serial', 'This serial number is already in use');
  }

  private async changeDeleted(
    tx: InventoryTransaction,
    scope: FmcsScope,
    row: Hardware,
    user: AuthenticatedUserContext,
    restore: boolean,
  ) {
    if (restore) {
      if (!row.assetTag) fieldIssue('asset_tag', 'An asset tag is required for restoration');
      await this.assertTag(tx, row.assetTag, row.id);
      const [config] = await tx
        .select({ unique: settings.uniqueSerial })
        .from(settings)
        .orderBy(settings.id)
        .limit(1)
        .for('update');
      await this.assertSerial(tx, row.serial, config?.unique ?? false, row.id);
      const model = row.modelId === null ? null : await this.modelService.find(tx, row.modelId);
      if (model?.requireSerial && !row.serial)
        fieldIssue('serial', 'Serial number is required by this model');
      if (row.companyId !== null)
        await this.directory.reference(tx, scope, 'companies', row.companyId);
      if (row.statusId !== null && !(await this.status(tx, row.statusId)))
        fieldIssue('status_id', 'The asset status is unavailable');
      await this.validation.checkRestore(
        tx,
        await this.validation.fields(tx, model?.fieldsetId ?? null),
        row.customFields,
        row.id,
      );
    } else {
      const [child] = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(
            isNull(assets.deletedAt),
            eq(assets.assignedType, 'asset'),
            eq(assets.assignedTo, row.id),
          ),
        )
        .limit(1);
      const [seat] = await tx
        .select({ id: licenseSeats.id })
        .from(licenseSeats)
        .where(and(eq(licenseSeats.assetId, row.id), isNull(licenseSeats.deletedAt)))
        .limit(1);
      const [request] = await tx
        .select({ id: checkoutRequests.id })
        .from(checkoutRequests)
        .where(
          and(
            eq(checkoutRequests.requestableType, 'asset'),
            eq(checkoutRequests.requestableId, row.id),
            eq(checkoutRequests.state, 'pending'),
            isNull(checkoutRequests.deletedAt),
          ),
        )
        .limit(1);
      if (row.assignedTo !== null || child || seat || request)
        throw new ConflictException('This asset is still in use');
    }
    await tx
      .update(assets)
      .set({ deletedAt: restore ? null : new Date(), updatedAt: new Date() })
      .where(eq(assets.id, row.id));
    await this.log(tx, row, user.id, restore ? 'restore' : 'delete');
  }

  async log(tx: InventoryTransaction, row: Hardware, actorId: number, actionType: string) {
    await tx.insert(actionLogs).values({
      actionType,
      itemType: 'asset',
      itemId: row.id,
      createdBy: actorId,
      companyId: row.companyId,
      locationId: row.locationId,
      actionDate: new Date(),
      actionSource: 'api',
    });
  }

  async history(
    kind: 'asset' | 'model',
    id: number,
    query: HardwareQuery,
    user: AuthenticatedUserContext,
    url: string,
  ) {
    const scope = await this.fmcs.resolve(user);
    if (kind === 'asset') await this.find(this.db, scope, id);
    else await this.modelService.find(this.db, id);
    const filters = and(
      eq(actionLogs.itemType, kind),
      eq(actionLogs.itemId, id),
      isNull(actionLogs.deletedAt),
      kind === 'asset'
        ? this.fmcs.predicate(scope, 'history', actionLogs.id, actionLogs.companyId)
        : undefined,
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
        action_date: formattedDate(row.actionDate ?? row.createdAt),
        target_type: row.targetType,
        target_id:
          row.targetType !== 'user' || permitsEntity(user, 'users.view') ? row.targetId : null,
        note: row.note,
      })),
      query,
      url,
    );
  }

  serialize(
    row: Hardware,
    status: StatusLabel | null,
    entries: FieldsetEntry[],
    user: AuthenticatedUserContext,
  ) {
    const currentStatus = assetStatus(row, status);
    const canEdit = permitsEntity(user, 'assets.edit');
    const canDelete = permitsEntity(user, 'assets.delete');
    return {
      id: row.id,
      name: row.name,
      asset_tag: row.assetTag,
      serial: row.serial,
      company_id: row.companyId,
      model_id: row.modelId,
      status_id: row.statusId,
      status_label: status?.name ?? null,
      status_meta: currentStatus,
      status_meta_label: status?.name ?? null,
      assigned_type: row.assignedType,
      accepted: row.accepted,
      assigned_to:
        row.assignedType !== 'user' || permitsEntity(user, 'users.view') ? row.assignedTo : null,
      location_id: row.locationId,
      rtd_location_id: row.rtdLocationId,
      supplier_id: row.supplierId,
      purchase_date: formattedDate(row.purchaseDate),
      purchase_cost: row.purchaseCost,
      order_number: row.orderNumber,
      warranty_months: row.warrantyMonths,
      asset_eol_date: formattedDate(row.assetEolDate),
      byod: row.byod,
      last_checkout: formattedDate(row.lastCheckout),
      last_checkin: formattedDate(row.lastCheckin),
      expected_checkin: formattedDate(row.expectedCheckin),
      checkout_counter: row.checkoutCounter,
      checkin_counter: row.checkinCounter,
      requests_counter: row.requestsCounter,
      requestable: row.requestable,
      notes: row.notes,
      custom_fields: this.validation.serialize(entries, row.customFields, user),
      custom_field_schema: this.validation.describe(entries, 'asset'),
      available_actions: row.deletedAt
        ? { restore: canDelete, bulk_selectable: { restore: canDelete } }
        : {
            view: true,
            update: canEdit,
            delete: canDelete && row.assignedTo === null,
            checkout: permitsKey(user, 'assets.checkout') && currentStatus === 'deployable',
            checkin: permitsKey(user, 'assets.checkin') && row.assignedTo !== null,
            bulk_selectable: { edit: canEdit, delete: canDelete && row.assignedTo === null },
          },
    };
  }
}

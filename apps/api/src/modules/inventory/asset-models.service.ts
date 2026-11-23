import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  AssetModelInputSchema,
  type AuthenticatedUserContext,
  type DatatableQuery,
  type SelectlistQuery,
} from '@kestrel-it/shared';
import { and, asc, count, desc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { permitsEntity } from '../../common/guards/permissions.guard.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import {
  actionLogs,
  assets,
  checkoutRequests,
  customFieldDefaults,
  customFieldsets,
  depreciations,
  models,
} from '../../db/schema/index.js';
import { DirectoryService } from './directory.service.js';
import { FmcsScopeService } from './fmcs-scope.service.js';
import { CustomFieldsValidationService, fieldIssue } from './custom-fields-validation.service.js';
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

type AssetModel = typeof models.$inferSelect;

@Injectable()
export class AssetModelsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(DirectoryService) private readonly directory: DirectoryService,
    @Inject(FmcsScopeService) private readonly fmcs: FmcsScopeService,
    @Inject(CustomFieldsValidationService)
    private readonly validation: CustomFieldsValidationService,
  ) {}

  async list(
    query: DatatableQuery & { deleted?: string },
    user: AuthenticatedUserContext,
    url: string,
  ) {
    const predicate = and(
      query.deleted === '1' ? isNotNull(models.deletedAt) : isNull(models.deletedAt),
      query.search
        ? or(contains(models.name, query.search), contains(models.modelNumber, query.search))
        : undefined,
    );
    const order = query.order === 'desc' ? desc : asc;
    const column = query.sort === 'model_number' ? models.modelNumber : models.name;
    const [[total], rows] = await Promise.all([
      this.db.select({ value: count() }).from(models).where(predicate),
      this.db
        .select()
        .from(models)
        .where(predicate)
        .orderBy(order(column), models.id)
        .limit(query.limit)
        .offset(pageOffset(query)),
    ]);
    return datatable(
      total!.value,
      rows.map((row) => this.serialize(row, user)),
      query,
      url,
    );
  }

  async options(query: SelectlistQuery, onlyDepreciations = false) {
    const table = onlyDepreciations ? depreciations : models;
    const predicate = and(
      onlyDepreciations ? undefined : isNull(models.deletedAt),
      query.search ? contains(table.name, query.search) : undefined,
    );
    const [[total], rows] = await Promise.all([
      this.db.select({ value: count() }).from(table).where(predicate),
      this.db
        .select({ id: table.id, name: table.name })
        .from(table)
        .where(predicate)
        .orderBy(table.name, table.id)
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
    ]);
    return selectlist(
      total!.value,
      rows.map(({ id, name }) => ({ id, text: name, image: null, tag_color: null })),
      query,
    );
  }

  async get(id: number, user: AuthenticatedUserContext) {
    const row = await this.find(this.db, id);
    return {
      ...this.serialize(row, user),
      custom_field_schema: this.validation.describe(
        await this.validation.fields(this.db, row.fieldsetId),
        'asset',
      ),
    };
  }

  async find(db: InventoryDatabase, id: number, deleted = false): Promise<AssetModel> {
    const [row] = await db
      .select()
      .from(models)
      .where(
        and(eq(models.id, id), deleted ? isNotNull(models.deletedAt) : isNull(models.deletedAt)),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Asset model not found');
    return row;
  }

  async save(body: unknown, user: AuthenticatedUserContext, id?: number) {
    return inventoryWrite(this.db, async (tx) =>
      success(await this.saveInTransaction(tx, body, user, id)),
    );
  }

  async saveInTransaction(
    tx: InventoryTransaction,
    body: unknown,
    user: AuthenticatedUserContext,
    id?: number,
  ) {
    const dto =
      id === undefined
        ? parse(AssetModelInputSchema, body)
        : parse(AssetModelInputSchema.partial(), body);
    const current = id === undefined ? undefined : await this.find(tx, id);
    const scope = await this.fmcs.resolve(user, tx);
    if (dto.manufacturer_id != null)
      await this.directory.reference(tx, scope, 'manufacturers', dto.manufacturer_id);
    if (dto.category_id != null) {
      const category = await this.directory.reference(tx, scope, 'categories', dto.category_id);
      if (category.categoryType !== 'asset') fieldIssue('category_id', 'Choose an asset category');
    }
    if (dto.depreciation_id != null) {
      const [value] = await tx
        .select({ id: depreciations.id })
        .from(depreciations)
        .where(eq(depreciations.id, dto.depreciation_id))
        .limit(1);
      if (!value) fieldIssue('depreciation_id', 'Depreciation schedule not found');
    }
    if (dto.fieldset_id != null) {
      const [value] = await tx
        .select({ id: customFieldsets.id })
        .from(customFieldsets)
        .where(eq(customFieldsets.id, dto.fieldset_id))
        .limit(1);
      if (!value) fieldIssue('fieldset_id', 'Fieldset not found');
    }
    if (current && dto.fieldset_id !== undefined && dto.fieldset_id !== current.fieldsetId) {
      const [linked] = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.modelId, current.id))
        .limit(1);
      if (linked) throw new ConflictException('Move existing assets before changing this fieldset');
      await tx.delete(customFieldDefaults).where(eq(customFieldDefaults.modelId, current.id));
    }
    if (current && dto.require_serial === true && !current.requireSerial) {
      const [missing] = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(
            eq(assets.modelId, current.id),
            isNull(assets.deletedAt),
            or(isNull(assets.serial), eq(assets.serial, '')),
          ),
        )
        .limit(1);
      if (missing) fieldIssue('require_serial', 'Existing assets need serial numbers first');
    }
    const fields = {
      modelNumber: dto.model_number,
      manufacturerId: dto.manufacturer_id,
      categoryId: dto.category_id,
      fieldsetId: dto.fieldset_id,
      depreciationId: dto.depreciation_id,
      eol: dto.eol,
      minAmt: dto.min_amt,
      requireSerial: dto.require_serial,
      requestable: dto.requestable,
      notes: dto.notes,
      updatedAt: new Date(),
    };
    const [saved] = current
      ? await tx
          .update(models)
          .set({ ...fields, name: dto.name })
          .where(eq(models.id, current.id))
          .returning()
      : await tx
          .insert(models)
          .values({ ...fields, name: dto.name!, createdBy: user.id })
          .returning();
    await tx.insert(actionLogs).values({
      actionType: current ? 'update' : 'create',
      itemType: 'model',
      itemId: saved!.id,
      createdBy: user.id,
      actionDate: new Date(),
      actionSource: 'api',
    });
    return this.serialize(saved!, user);
  }

  async clone(id: number, name: string, user: AuthenticatedUserContext) {
    return inventoryWrite(this.db, async (tx) => {
      const { id: _, createdAt, updatedAt, deletedAt, ...source } = await this.find(tx, id);
      const [created] = await tx
        .insert(models)
        .values({ ...source, name, createdBy: user.id })
        .returning();
      const defaults = await tx
        .select()
        .from(customFieldDefaults)
        .where(eq(customFieldDefaults.modelId, id));
      if (defaults.length)
        await tx.insert(customFieldDefaults).values(
          defaults.map(({ customFieldId, defaultValue }) => ({
            customFieldId,
            defaultValue,
            modelId: created!.id,
          })),
        );
      await tx.insert(actionLogs).values({
        actionType: 'create',
        itemType: 'model',
        itemId: created!.id,
        createdBy: user.id,
        actionDate: new Date(),
        actionSource: 'api',
      });
      return success(this.serialize(created!, user));
    });
  }

  async changeDeleted(id: number, restore: boolean, user: AuthenticatedUserContext) {
    return inventoryWrite(this.db, async (tx) => {
      const current = await this.find(tx, id, restore);
      if (restore) {
        const scope = await this.fmcs.resolve(user, tx);
        if (current.categoryId !== null)
          await this.directory.reference(tx, scope, 'categories', current.categoryId);
        if (current.manufacturerId !== null)
          await this.directory.reference(tx, scope, 'manufacturers', current.manufacturerId);
      } else {
        const [asset] = await tx
          .select({ id: assets.id })
          .from(assets)
          .where(and(eq(assets.modelId, id), isNull(assets.deletedAt)))
          .limit(1);
        if (asset) throw new ConflictException('The model has active assets');
        const [request] = await tx
          .select({ id: checkoutRequests.id })
          .from(checkoutRequests)
          .where(
            and(
              eq(checkoutRequests.requestableType, 'model'),
              eq(checkoutRequests.requestableId, id),
              eq(checkoutRequests.state, 'pending'),
              isNull(checkoutRequests.deletedAt),
            ),
          )
          .limit(1);
        if (request) throw new ConflictException('The model has pending checkout requests');
      }
      await tx
        .update(models)
        .set({ deletedAt: restore ? null : new Date(), updatedAt: new Date() })
        .where(eq(models.id, id));
      await tx.insert(actionLogs).values({
        actionType: restore ? 'restore' : 'delete',
        itemType: 'model',
        itemId: id,
        createdBy: user.id,
        actionDate: new Date(),
        actionSource: 'api',
      });
      return success({ id });
    });
  }

  serialize(row: AssetModel, user: AuthenticatedUserContext) {
    return {
      id: row.id,
      name: row.name,
      model_number: row.modelNumber,
      manufacturer_id: row.manufacturerId,
      category_id: row.categoryId,
      fieldset_id: row.fieldsetId,
      depreciation_id: row.depreciationId,
      eol: row.eol,
      min_amt: row.minAmt,
      require_serial: row.requireSerial,
      requestable: row.requestable,
      notes: row.notes,
      available_actions: row.deletedAt
        ? { restore: permitsEntity(user, 'models.delete') }
        : {
            view: true,
            update: permitsEntity(user, 'models.edit'),
            delete: permitsEntity(user, 'models.delete'),
            clone: permitsEntity(user, 'models.create'),
          },
    };
  }
}

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CUSTOM_FIELD_FORMATS,
  CustomFieldAssociationSchema,
  CustomFieldInputSchema,
  CustomFieldOrderSchema,
  CustomFieldValuesSchema,
  CustomFieldsetInputSchema,
  allowedElementKeysForFormat,
  canEncryptFor,
  elementRequiresFieldValues,
  generateCustomFieldDbColumn,
  normalizeFormatLabel,
  parseFieldValuesOptions,
  type AuthenticatedUserContext,
  type DatatableQuery,
  type PermissionKey,
  type SelectlistQuery,
} from '@kestrel-it/shared';
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { permitsEntity, permitsKey } from '../../common/guards/permissions.guard.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import {
  assets,
  customFieldCustomFieldset as pivot,
  customFieldDefaults,
  customFields,
  customFieldsets,
  models,
} from '../../db/schema/index.js';
import {
  CustomFieldsValidationService,
  fieldIssue,
  pattern,
} from './custom-fields-validation.service.js';
import {
  contains,
  datatable,
  inventoryWrite,
  pageOffset,
  parse,
  selectlist,
  success,
  type InventoryDatabase,
} from './inventory-queries.js';

type Catalog = 'fields' | 'fieldsets';
type Field = typeof customFields.$inferSelect;
const mappedFlags = {
  field_encrypted: 'fieldEncrypted',
  is_unique: 'isUnique',
  auto_add_to_fieldsets: 'autoAddToFieldsets',
  show_in_listview: 'showInListview',
  show_in_email: 'showInEmail',
  show_in_requestable_list: 'showInRequestableList',
  display_in_user_view: 'displayInUserView',
  display_checkout: 'displayCheckout',
  display_checkin: 'displayCheckin',
  display_audit: 'displayAudit',
} as const;

function allowed(user: AuthenticatedUserContext, permission: PermissionKey): void {
  if (!permitsEntity(user, permission)) throw new ForbiddenException('Insufficient permissions');
}

@Injectable()
export class CustomFieldsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(CustomFieldsValidationService)
    private readonly validation: CustomFieldsValidationService,
  ) {}

  private presentField(field: Field, user: AuthenticatedUserContext) {
    return {
      id: field.id,
      name: field.name,
      db_column: field.dbColumn,
      element: field.element,
      format: field.format,
      field_values: field.fieldValues,
      help_text: field.helpText,
      ...Object.fromEntries(
        Object.entries(mappedFlags).map(([api, property]) => [api, field[property]]),
      ),
      available_actions: this.actions(user),
    };
  }

  private actions(user: AuthenticatedUserContext) {
    return {
      update: permitsEntity(user, 'customfields.edit'),
      delete: permitsEntity(user, 'customfields.delete'),
    };
  }

  async list(kind: Catalog, query: DatatableQuery, user: AuthenticatedUserContext, url: string) {
    allowed(user, 'customfields.view');
    const table = kind === 'fields' ? customFields : customFieldsets;
    const predicate = query.search ? contains(table.name, query.search) : undefined;
    const order = query.order === 'desc' ? desc : asc;
    const [[total], rows] = await Promise.all([
      this.db.select({ total: count() }).from(table).where(predicate),
      this.db
        .select()
        .from(table)
        .where(predicate)
        .orderBy(order(table.name), table.id)
        .limit(query.limit)
        .offset(pageOffset(query)),
    ]);
    return datatable(
      total!.total,
      rows.map((row) =>
        'dbColumn' in row
          ? this.presentField(row, user)
          : { id: row.id, name: row.name, available_actions: this.actions(user) },
      ),
      query,
      url,
    );
  }

  async options(kind: Catalog, query: SelectlistQuery, user: AuthenticatedUserContext) {
    if (!permitsEntity(user, 'models.edit') && !permitsEntity(user, 'models.create')) {
      allowed(user, 'customfields.view');
    }
    const table = kind === 'fields' ? customFields : customFieldsets;
    const predicate = query.search ? contains(table.name, query.search) : undefined;
    const [[total], rows] = await Promise.all([
      this.db.select({ total: count() }).from(table).where(predicate),
      this.db
        .select({ id: table.id, name: table.name })
        .from(table)
        .where(predicate)
        .orderBy(table.name, table.id)
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
    ]);
    return selectlist(
      total!.total,
      rows.map(({ id, name }) => ({ id, text: name, image: null, tag_color: null })),
      query,
    );
  }

  async get(kind: Catalog, id: number, actor: AuthenticatedUserContext) {
    allowed(actor, 'customfields.view');
    if (kind === 'fields') return this.presentField(await this.getField(this.db, id), actor);
    const fieldset = await this.getFieldset(this.db, id);
    const entries = await this.validation.fields(this.db, id);
    return {
      id,
      name: fieldset.name,
      fields: this.validation.describe(entries, 'asset'),
      available_actions: this.actions(actor),
    };
  }

  async saveField(input: unknown, user: AuthenticatedUserContext, id?: number) {
    allowed(user, id === undefined ? 'customfields.create' : 'customfields.edit');
    const dto =
      id === undefined
        ? parse(CustomFieldInputSchema, input)
        : parse(CustomFieldInputSchema.partial(), input);
    return inventoryWrite(this.db, async (tx) => {
      const existing = id === undefined ? undefined : await this.getField(tx, id);
      const element = dto.element ?? existing!.element;
      const format = dto.format !== undefined ? dto.format : (existing?.format ?? null);
      const fieldValues =
        dto.field_values !== undefined ? dto.field_values : (existing?.fieldValues ?? null);
      const fieldEncrypted = dto.field_encrypted ?? existing?.fieldEncrypted ?? false;
      const isUnique = dto.is_unique ?? existing?.isUnique ?? false;
      this.validateDefinition(element, format, fieldValues, fieldEncrypted);
      if (
        existing &&
        (element !== existing.element ||
          format !== existing.format ||
          fieldValues !== existing.fieldValues ||
          fieldEncrypted !== existing.fieldEncrypted ||
          isUnique !== existing.isUnique)
      ) {
        await this.assertFieldHasNoValues(tx, existing);
      }
      const changes: Partial<typeof customFields.$inferInsert> = {
        name: dto.name,
        element,
        format,
        fieldValues,
        fieldEncrypted,
        isUnique,
        helpText: dto.help_text,
        updatedAt: new Date(),
      };
      for (const [key, property] of Object.entries(mappedFlags)) {
        const value = dto[key as keyof typeof dto];
        if (typeof value === 'boolean') changes[property] = value;
      }
      if (existing) {
        const [saved] = await tx
          .update(customFields)
          .set(changes)
          .where(eq(customFields.id, existing.id))
          .returning();
        return success(this.presentField(saved!, user));
      }
      const [created] = await tx
        .insert(customFields)
        .values({
          ...changes,
          name: dto.name!,
          element,
          dbColumn: randomUUID(),
          createdBy: user.id,
        })
        .returning();
      const [saved] = await tx
        .update(customFields)
        .set({
          dbColumn: generateCustomFieldDbColumn(created!.name, created!.id),
        })
        .where(eq(customFields.id, created!.id))
        .returning();
      return success(this.presentField(saved!, user));
    });
  }

  async saveFieldset(input: unknown, user: AuthenticatedUserContext, id?: number) {
    allowed(user, id === undefined ? 'customfields.create' : 'customfields.edit');
    const { name } = parse(CustomFieldsetInputSchema, input);
    return inventoryWrite(this.db, async (tx) => {
      if (id !== undefined) {
        await this.getFieldset(tx, id);
        await tx
          .update(customFieldsets)
          .set({ name, updatedAt: new Date() })
          .where(eq(customFieldsets.id, id));
        return success({ id, name });
      }
      const [created] = await tx
        .insert(customFieldsets)
        .values({ name, createdBy: user.id })
        .returning();
      const fields = await tx
        .select({ id: customFields.id })
        .from(customFields)
        .where(eq(customFields.autoAddToFieldsets, true))
        .orderBy(customFields.id);
      if (fields.length)
        await tx.insert(pivot).values(
          fields.map((field, order) => ({
            customFieldId: field.id,
            customFieldsetId: created!.id,
            order,
          })),
        );
      return success({ id: created!.id, name });
    });
  }

  async remove(kind: Catalog, id: number, user: AuthenticatedUserContext) {
    allowed(user, 'customfields.delete');
    return inventoryWrite(this.db, async (tx) => {
      if (kind === 'fields') {
        const field = await this.getField(tx, id);
        const [association] = await tx
          .select({ fieldsetId: pivot.customFieldsetId })
          .from(pivot)
          .where(eq(pivot.customFieldId, id))
          .limit(1);
        if (association) throw new ConflictException('This field is used by a fieldset');
        await this.assertFieldHasNoValues(tx, field);
        await tx.delete(customFields).where(eq(customFields.id, id));
      } else {
        await this.getFieldset(tx, id);
        const [model] = await tx
          .select({ id: models.id })
          .from(models)
          .where(eq(models.fieldsetId, id))
          .limit(1);
        if (model) throw new ConflictException('This fieldset is used by an asset model');
        await tx.delete(customFieldsets).where(eq(customFieldsets.id, id));
      }
      return success({ id });
    });
  }

  async associate(
    fieldsetId: number,
    input: unknown,
    user: AuthenticatedUserContext,
    remove = false,
  ) {
    allowed(user, 'customfields.edit');
    const dto = parse(CustomFieldAssociationSchema, input);
    return inventoryWrite(this.db, async (tx) => {
      await this.getFieldset(tx, fieldsetId);
      const field = await this.getField(tx, dto.field_id);
      const selector = and(
        eq(pivot.customFieldsetId, fieldsetId),
        eq(pivot.customFieldId, field.id),
      );
      const entries = await this.validation.fields(tx, fieldsetId);
      const existing = entries.find((entry) => entry.field.id === field.id);
      if (remove) {
        const [model] = await tx
          .select({ id: models.id })
          .from(models)
          .where(eq(models.fieldsetId, fieldsetId))
          .limit(1);
        if (model) {
          const [saved] = await tx
            .select({ id: assets.id })
            .from(assets)
            .innerJoin(models, eq(assets.modelId, models.id))
            .where(
              and(
                eq(models.fieldsetId, fieldsetId),
                sql`jsonb_exists(${assets.customFields}, ${field.dbColumn})`,
              ),
            )
            .limit(1);
          if (saved) throw new ConflictException('This field has saved values in the fieldset');
          const savedDefaults = await tx
            .select({ id: customFieldDefaults.id })
            .from(customFieldDefaults)
            .innerJoin(models, eq(customFieldDefaults.modelId, models.id))
            .where(
              and(
                eq(models.fieldsetId, fieldsetId),
                eq(customFieldDefaults.customFieldId, field.id),
              ),
            )
            .limit(1);
          if (savedDefaults.length)
            throw new ConflictException('This field has model defaults in the fieldset');
        }
        await tx.delete(pivot).where(selector);
      } else {
        if (dto.required && !existing?.required) {
          const [existingAsset] = await tx
            .select({ id: assets.id })
            .from(assets)
            .innerJoin(models, eq(assets.modelId, models.id))
            .where(
              and(
                eq(models.fieldsetId, fieldsetId),
                isNull(assets.deletedAt),
                sql`not jsonb_exists(${assets.customFields}, ${field.dbColumn})`,
              ),
            )
            .limit(1);
          if (existingAsset)
            throw new ConflictException(
              'Existing assets need a value before this field can be required',
            );
        }
        const next = await tx
          .select({ next: sql<number>`coalesce(max(${pivot.order}), -1) + 1` })
          .from(pivot)
          .where(eq(pivot.customFieldsetId, fieldsetId));
        await tx
          .insert(pivot)
          .values({
            customFieldsetId: fieldsetId,
            customFieldId: field.id,
            required: dto.required,
            order: next[0]!.next,
          })
          .onConflictDoUpdate({
            target: [pivot.customFieldId, pivot.customFieldsetId],
            set: { required: dto.required },
          });
      }
      return success({ fieldset_id: fieldsetId, field_id: field.id });
    });
  }

  async reorder(fieldsetId: number, input: unknown, user: AuthenticatedUserContext) {
    allowed(user, 'customfields.edit');
    const { field_ids: ids } = parse(CustomFieldOrderSchema, input);
    return inventoryWrite(this.db, async (tx) => {
      await this.getFieldset(tx, fieldsetId);
      const entries = await this.validation.fields(tx, fieldsetId);
      if (
        ids.length !== entries.length ||
        new Set(ids).size !== ids.length ||
        entries.some(({ field }) => !ids.includes(field.id))
      ) {
        fieldIssue('field_ids', 'Provide each field attached to this fieldset exactly once');
      }
      for (const [order, fieldId] of ids.entries()) {
        await tx
          .update(pivot)
          .set({ order })
          .where(and(eq(pivot.customFieldsetId, fieldsetId), eq(pivot.customFieldId, fieldId)));
      }
      return success({ field_ids: ids });
    });
  }

  async getDefaults(fieldsetId: number, modelId: number, user: AuthenticatedUserContext) {
    allowed(user, 'models.view');
    const entries = await this.modelFields(this.db, fieldsetId, modelId);
    const rows = await this.db
      .select()
      .from(customFieldDefaults)
      .where(eq(customFieldDefaults.modelId, modelId));
    const defaults = new Map(rows.map((row) => [row.customFieldId, row.defaultValue]));
    const canDecrypt = permitsKey(user, 'assets.view.encrypted_custom_fields');
    return Object.fromEntries(
      entries
        .filter(({ field }) => defaults.has(field.id))
        .map(({ field }) => [
          field.dbColumn,
          field.fieldEncrypted && !canDecrypt
            ? 'ENCRYPTED'
            : this.validation.decodeDefault(field, defaults.get(field.id)!),
        ]),
    );
  }

  async saveDefaults(
    fieldsetId: number,
    modelId: number,
    input: unknown,
    user: AuthenticatedUserContext,
  ) {
    allowed(user, 'models.edit');
    const dto = parse(CustomFieldValuesSchema, input);
    return inventoryWrite(this.db, async (tx) => {
      const fields = new Map(
        (await this.modelFields(tx, fieldsetId, modelId)).map(({ field }) => [
          field.dbColumn,
          field,
        ]),
      );
      for (const [key, value] of Object.entries(dto)) {
        const field = fields.get(key);
        if (!field) fieldIssue(key, 'The field is outside this model fieldset');
        const checked = await this.validation.validateValue(field, value, false);
        if (checked == null || checked === '' || (Array.isArray(checked) && checked.length === 0)) {
          await tx
            .delete(customFieldDefaults)
            .where(
              and(
                eq(customFieldDefaults.customFieldId, field.id),
                eq(customFieldDefaults.modelId, modelId),
              ),
            );
          continue;
        }
        const stored = field.fieldEncrypted
          ? String(this.validation.encode(field, checked))
          : JSON.stringify(checked);
        await tx
          .insert(customFieldDefaults)
          .values({ modelId, customFieldId: field.id, defaultValue: stored })
          .onConflictDoUpdate({
            target: [customFieldDefaults.modelId, customFieldDefaults.customFieldId],
            set: { defaultValue: stored, updatedAt: new Date() },
          });
      }
      return success({ model_id: modelId });
    });
  }

  private async modelFields(db: InventoryDatabase, fieldsetId: number, modelId: number) {
    const [model] = await db
      .select({ id: models.id })
      .from(models)
      .where(
        and(eq(models.id, modelId), eq(models.fieldsetId, fieldsetId), isNull(models.deletedAt)),
      )
      .limit(1);
    if (!model) throw new NotFoundException('Model fieldset not found');
    return this.validation.fields(db, fieldsetId);
  }

  private async getField(db: InventoryDatabase, id: number): Promise<Field> {
    const [row] = await db.select().from(customFields).where(eq(customFields.id, id)).limit(1);
    if (!row) throw new NotFoundException('Custom field not found');
    return row;
  }

  private async getFieldset(db: InventoryDatabase, id: number) {
    const [row] = await db
      .select()
      .from(customFieldsets)
      .where(eq(customFieldsets.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Fieldset not found');
    return row;
  }

  private async assertFieldHasNoValues(db: InventoryDatabase, field: Field) {
    const [[used], [model]] = await Promise.all([
      db
        .select({ id: assets.id })
        .from(assets)
        .where(sql`jsonb_exists(${assets.customFields}, ${field.dbColumn})`)
        .limit(1),
      db
        .select({ id: customFieldDefaults.id })
        .from(customFieldDefaults)
        .where(eq(customFieldDefaults.customFieldId, field.id))
        .limit(1),
    ]);
    if (used || model) throw new ConflictException('This field already has asset or model values');
  }

  private validateDefinition(
    element: Field['element'],
    format: string | null,
    values: string | null,
    encrypted: boolean,
  ) {
    const label = normalizeFormatLabel(format);
    if (label.startsWith('regex:')) {
      try {
        pattern(label);
      } catch {
        fieldIssue('format', 'Enter a valid custom regex');
      }
    } else if (label === 'CUSTOM REGEX' || !CUSTOM_FIELD_FORMATS.some((item) => item === label)) {
      fieldIssue('format', 'Choose a valid format or provide a custom regex');
    }
    if (!allowedElementKeysForFormat(label).includes(element))
      fieldIssue('element', 'This format cannot use that element');
    if (encrypted && !canEncryptFor(element, label))
      fieldIssue('field_encrypted', 'This format cannot be encrypted');
    const options = parseFieldValuesOptions(values);
    if (elementRequiresFieldValues(element) && options.length === 0)
      fieldIssue('field_values', 'Provide at least one option');
    if (new Set(options.map(({ value }) => value)).size !== options.length)
      fieldIssue('field_values', 'Options must be unique');
  }
}

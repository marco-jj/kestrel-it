import type { CheckoutTargetType, CustomFieldElement } from '@kestrel-it/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { identityId, timestamps, timestampsNoSoftDelete } from './_helpers.js';
import { companies } from './identity.js';
import {
  categories,
  depreciations,
  locations,
  manufacturers,
  statusLabels,
  suppliers,
} from './taxonomy.js';

export const customFields = pgTable(
  'custom_fields',
  {
    id: identityId(),
    name: varchar('name', { length: 255 }).notNull(),
    dbColumn: varchar('db_column', { length: 120 }).notNull(),
    element: varchar('element', { length: 64 }).$type<CustomFieldElement>().notNull(),
    format: varchar('format', { length: 500 }),
    fieldValues: text('field_values'),
    fieldEncrypted: boolean('field_encrypted').notNull().default(false),
    helpText: text('help_text'),
    isUnique: boolean('is_unique').notNull().default(false),
    autoAddToFieldsets: boolean('auto_add_to_fieldsets').notNull().default(false),
    showInListview: boolean('show_in_listview').notNull().default(false),
    showInEmail: boolean('show_in_email').notNull().default(false),
    showInRequestableList: boolean('show_in_requestable_list').notNull().default(false),
    displayInUserView: boolean('display_in_user_view').notNull().default(false),
    displayCheckout: boolean('display_checkout').notNull().default(false),
    displayCheckin: boolean('display_checkin').notNull().default(false),
    displayAudit: boolean('display_audit').notNull().default(false),
    createdBy: integer('created_by'),
    ...timestampsNoSoftDelete(),
  },
  (table) => [
    uniqueIndex('uq_custom_fields_name').on(table.name),
    uniqueIndex('uq_custom_fields_db_column').on(table.dbColumn),
  ],
);

export const customFieldsets = pgTable(
  'custom_fieldsets',
  {
    id: identityId(),
    name: varchar('name', { length: 255 }).notNull(),
    createdBy: integer('created_by'),
    ...timestampsNoSoftDelete(),
  },
  (table) => [uniqueIndex('uq_custom_fieldsets_name').on(table.name)],
);

export const customFieldCustomFieldset = pgTable(
  'custom_field_custom_fieldset',
  {
    id: identityId(),
    customFieldId: integer('custom_field_id')
      .notNull()
      .references(() => customFields.id, { onDelete: 'cascade' }),
    customFieldsetId: integer('custom_fieldset_id')
      .notNull()
      .references(() => customFieldsets.id, { onDelete: 'cascade' }),
    order: integer('order').notNull().default(0),
    required: boolean('required').notNull().default(false),
  },
  (table) => [
    uniqueIndex('uq_cf_fieldset_pair').on(table.customFieldId, table.customFieldsetId),
  ],
);

export const models = pgTable(
  'models',
  {
    id: identityId(),
    name: varchar('name', { length: 255 }).notNull(),
    modelNumber: varchar('model_number', { length: 255 }),
    mfgMarketingName: varchar('mfg_marketing_name', { length: 255 }),
    mfgReleaseDate: date('mfg_release_date'),
    mfgDiscontinuedDate: date('mfg_discontinued_date'),
    manufacturerId: integer('manufacturer_id').references(() => manufacturers.id, {
      onDelete: 'set null',
    }),
    categoryId: integer('category_id').references(() => categories.id, {
      onDelete: 'set null',
    }),
    depreciationId: integer('depreciation_id').references(() => depreciations.id, {
      onDelete: 'set null',
    }),
    fieldsetId: integer('fieldset_id').references(() => customFieldsets.id, {
      onDelete: 'set null',
    }),
    eol: integer('eol'),
    minAmt: integer('min_amt'),
    requireSerial: boolean('require_serial').notNull().default(false),
    requestable: boolean('requestable').notNull().default(false),
    image: varchar('image', { length: 255 }),
    notes: text('notes'),
    createdBy: integer('created_by'),
    ...timestamps(),
  },
  (table) => [
    index('idx_models_category_id').on(table.categoryId),
    index('idx_models_manufacturer_id').on(table.manufacturerId),
    index('idx_models_fieldset_id').on(table.fieldsetId),
    index('idx_models_depreciation_id').on(table.depreciationId),
  ],
);

export const customFieldDefaults = pgTable(
  'custom_field_defaults',
  {
    id: identityId(),
    modelId: integer('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),
    customFieldId: integer('custom_field_id')
      .notNull()
      .references(() => customFields.id, { onDelete: 'cascade' }),
    defaultValue: text('default_value'),
    ...timestampsNoSoftDelete(),
  },
  (table) => [uniqueIndex('uq_cf_default_model_field').on(table.modelId, table.customFieldId)],
);

export const assets = pgTable(
  'assets',
  {
    id: identityId(),
    name: varchar('name', { length: 255 }),
    assetTag: varchar('asset_tag', { length: 255 }),
    modelId: integer('model_id').references(() => models.id, { onDelete: 'set null' }),
    serial: varchar('serial', { length: 255 }),
    purchaseDate: date('purchase_date'),
    purchaseCost: numeric('purchase_cost', { precision: 20, scale: 2 }),
    orderNumber: varchar('order_number', { length: 255 }),
    supplierId: integer('supplier_id').references(() => suppliers.id, {
      onDelete: 'set null',
    }),
    statusId: integer('status_id').references(() => statusLabels.id, {
      onDelete: 'set null',
    }),
    companyId: integer('company_id').references(() => companies.id, {
      onDelete: 'set null',
    }),
    locationId: integer('location_id').references(() => locations.id, {
      onDelete: 'set null',
    }),
    rtdLocationId: integer('rtd_location_id').references(() => locations.id, {
      onDelete: 'set null',
    }),
    assignedTo: integer('assigned_to'),
    assignedType: varchar('assigned_type', { length: 32 }).$type<CheckoutTargetType>(),
    warrantyMonths: integer('warranty_months'),
    assetEolDate: date('asset_eol_date'),
    eolExplicit: boolean('eol_explicit').notNull().default(false),
    depreciate: boolean('depreciate').notNull().default(false),
    physical: boolean('physical').notNull().default(true),
    archived: boolean('archived').notNull().default(false),
    requestable: boolean('requestable').notNull().default(false),
    byod: boolean('byod').notNull().default(false),
    image: varchar('image', { length: 255 }),
    notes: text('notes'),
    lastCheckout: timestamp('last_checkout', { withTimezone: true }),
    lastCheckin: timestamp('last_checkin', { withTimezone: true }),
    expectedCheckin: date('expected_checkin'),
    lastAuditDate: timestamp('last_audit_date', { withTimezone: true }),
    nextAuditDate: date('next_audit_date'),
    checkinCounter: integer('checkin_counter').notNull().default(0),
    checkoutCounter: integer('checkout_counter').notNull().default(0),
    requestsCounter: integer('requests_counter').notNull().default(0),
    customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
    createdBy: integer('created_by'),
    ...timestamps(),
  },
  (table) => [
    index('idx_assets_asset_tag').on(table.assetTag),
    uniqueIndex('uq_assets_live_tag').on(table.assetTag).where(sql`${table.deletedAt} IS NULL`),
    index('idx_assets_serial').on(table.serial),
    index('idx_assets_model_id').on(table.modelId),
    index('idx_assets_status_id').on(table.statusId),
    index('idx_assets_company_id').on(table.companyId),
    index('idx_assets_assigned').on(table.assignedType, table.assignedTo),
    index('idx_assets_location_id').on(table.locationId),
    index('idx_assets_rtd_location_id').on(table.rtdLocationId),
    index('idx_assets_custom_fields_gin').using('gin', table.customFields),
  ],
);

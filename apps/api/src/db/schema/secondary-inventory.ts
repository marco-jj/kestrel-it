import type { CheckoutTargetType, PolymorphicItemType } from '@kestrel-it/shared';
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { identityId, timestamps, timestampsNoSoftDelete } from './_helpers.js';
import { assets, models } from './assets.js';
import { companies, users } from './identity.js';
import { categories, depreciations, locations, manufacturers, suppliers } from './taxonomy.js';

export const licenses = pgTable(
  'licenses',
  {
    id: identityId(),
    name: varchar('name', { length: 255 }).notNull(),
    serial: text('serial'),
    purchaseDate: date('purchase_date'),
    purchaseCost: numeric('purchase_cost', { precision: 20, scale: 2 }),
    orderNumber: varchar('order_number', { length: 255 }),
    purchaseOrder: varchar('purchase_order', { length: 255 }),
    seats: integer('seats').notNull().default(1),
    licenseName: varchar('license_name', { length: 255 }),
    licenseEmail: varchar('license_email', { length: 255 }),
    reassignable: boolean('reassignable').notNull().default(true),
    maintained: boolean('maintained').notNull().default(false),
    depreciate: boolean('depreciate').notNull().default(false),
    depreciationId: integer('depreciation_id').references(() => depreciations.id, {
      onDelete: 'set null',
    }),
    supplierId: integer('supplier_id').references(() => suppliers.id, {
      onDelete: 'set null',
    }),
    companyId: integer('company_id').references(() => companies.id, {
      onDelete: 'set null',
    }),
    manufacturerId: integer('manufacturer_id').references(() => manufacturers.id, {
      onDelete: 'set null',
    }),
    categoryId: integer('category_id').references(() => categories.id, {
      onDelete: 'set null',
    }),
    expirationDate: date('expiration_date'),
    terminationDate: date('termination_date'),
    minAmt: integer('min_amt'),
    requestable: boolean('requestable').notNull().default(false),
    notes: text('notes'),
    createdBy: integer('created_by'),
    ...timestamps(),
  },
  (table) => [
    index('idx_licenses_company_id').on(table.companyId),
    index('idx_licenses_category_id').on(table.categoryId),
    index('idx_licenses_expiration_date').on(table.expirationDate),
  ],
);

export const licenseSeats = pgTable(
  'license_seats',
  {
    id: identityId(),
    licenseId: integer('license_id')
      .notNull()
      .references(() => licenses.id, { onDelete: 'cascade' }),
    assignedTo: integer('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    assetId: integer('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    unreassignableSeat: boolean('unreassignable_seat').notNull().default(false),
    notes: text('notes'),
    createdBy: integer('created_by'),
    ...timestamps(),
  },
  (table) => [
    index('idx_license_seats_license_id').on(table.licenseId),
    index('idx_license_seats_assigned_to').on(table.assignedTo),
    index('idx_license_seats_asset_id').on(table.assetId),
  ],
);

export const accessories = pgTable(
  'accessories',
  {
    id: identityId(),
    name: varchar('name', { length: 255 }).notNull(),
    categoryId: integer('category_id').references(() => categories.id, {
      onDelete: 'set null',
    }),
    manufacturerId: integer('manufacturer_id').references(() => manufacturers.id, {
      onDelete: 'set null',
    }),
    defaultSupplierId: integer('default_supplier_id').references(() => suppliers.id, {
      onDelete: 'set null',
    }),
    companyId: integer('company_id').references(() => companies.id, {
      onDelete: 'set null',
    }),
    locationId: integer('location_id').references(() => locations.id, {
      onDelete: 'set null',
    }),
    modelNumber: varchar('model_number', { length: 255 }),
    qty: integer('qty').notNull().default(0),
    minAmt: integer('min_amt'),
    defaultPurchaseCost: numeric('default_purchase_cost', { precision: 20, scale: 2 }),
    legacyPurchaseDate: date('legacy_purchase_date'),
    legacyOrderNumber: varchar('legacy_order_number', { length: 255 }),
    requestable: boolean('requestable').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    image: varchar('image', { length: 255 }),
    notes: text('notes'),
    createdBy: integer('created_by'),
    ...timestamps(),
  },
  (table) => [
    index('idx_accessories_company_id').on(table.companyId),
    index('idx_accessories_category_id').on(table.categoryId),
    index('idx_accessories_location_id').on(table.locationId),
  ],
);

export const accessoriesCheckout = pgTable(
  'accessories_checkout',
  {
    id: identityId(),
    accessoryId: integer('accessory_id')
      .notNull()
      .references(() => accessories.id, { onDelete: 'cascade' }),
    assignedTo: integer('assigned_to').notNull(),
    assignedType: varchar('assigned_type', { length: 32 })
      .$type<CheckoutTargetType>()
      .notNull()
      .default('user'),
    note: text('note'),
    createdBy: integer('created_by'),
    ...timestampsNoSoftDelete(),
  },
  (table) => [
    index('idx_acc_checkout_accessory_id').on(table.accessoryId),
    index('idx_acc_checkout_assigned').on(table.assignedType, table.assignedTo),
  ],
);

export const consumables = pgTable(
  'consumables',
  {
    id: identityId(),
    name: varchar('name', { length: 255 }).notNull(),
    categoryId: integer('category_id').references(() => categories.id, {
      onDelete: 'set null',
    }),
    manufacturerId: integer('manufacturer_id').references(() => manufacturers.id, {
      onDelete: 'set null',
    }),
    defaultSupplierId: integer('default_supplier_id').references(() => suppliers.id, {
      onDelete: 'set null',
    }),
    companyId: integer('company_id').references(() => companies.id, {
      onDelete: 'set null',
    }),
    locationId: integer('location_id').references(() => locations.id, {
      onDelete: 'set null',
    }),
    modelNumber: varchar('model_number', { length: 255 }),
    itemNo: varchar('item_no', { length: 255 }),
    qty: integer('qty').notNull().default(0),
    minAmt: integer('min_amt'),
    defaultPurchaseCost: numeric('default_purchase_cost', { precision: 20, scale: 2 }),
    legacyPurchaseDate: date('legacy_purchase_date'),
    legacyOrderNumber: varchar('legacy_order_number', { length: 255 }),
    requestable: boolean('requestable').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    image: varchar('image', { length: 255 }),
    notes: text('notes'),
    createdBy: integer('created_by'),
    ...timestamps(),
  },
  (table) => [
    index('idx_consumables_company_id').on(table.companyId),
    index('idx_consumables_category_id').on(table.categoryId),
    index('idx_consumables_location_id').on(table.locationId),
  ],
);

export const consumablesUsers = pgTable(
  'consumables_users',
  {
    id: identityId(),
    consumableId: integer('consumable_id')
      .notNull()
      .references(() => consumables.id, { onDelete: 'cascade' }),
    assignedTo: integer('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    note: text('note'),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdBy: integer('created_by'),
    ...timestampsNoSoftDelete(),
  },
  (table) => [
    index('idx_consumables_users_consumable_id').on(table.consumableId),
    index('idx_consumables_users_assigned_to').on(table.assignedTo),
  ],
);

export const components = pgTable(
  'components',
  {
    id: identityId(),
    name: varchar('name', { length: 255 }).notNull(),
    categoryId: integer('category_id').references(() => categories.id, {
      onDelete: 'set null',
    }),
    manufacturerId: integer('manufacturer_id').references(() => manufacturers.id, {
      onDelete: 'set null',
    }),
    defaultSupplierId: integer('default_supplier_id').references(() => suppliers.id, {
      onDelete: 'set null',
    }),
    companyId: integer('company_id').references(() => companies.id, {
      onDelete: 'set null',
    }),
    locationId: integer('location_id').references(() => locations.id, {
      onDelete: 'set null',
    }),
    modelNumber: varchar('model_number', { length: 255 }),
    serial: varchar('serial', { length: 255 }),
    qty: integer('qty').notNull().default(0),
    minAmt: integer('min_amt'),
    defaultPurchaseCost: numeric('default_purchase_cost', { precision: 20, scale: 2 }),
    legacyPurchaseDate: date('legacy_purchase_date'),
    legacyOrderNumber: varchar('legacy_order_number', { length: 255 }),
    requestable: boolean('requestable').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    image: varchar('image', { length: 255 }),
    notes: text('notes'),
    createdBy: integer('created_by'),
    ...timestamps(),
  },
  (table) => [
    index('idx_components_company_id').on(table.companyId),
    index('idx_components_category_id').on(table.categoryId),
    index('idx_components_location_id').on(table.locationId),
  ],
);

export const componentsAssets = pgTable(
  'components_assets',
  {
    id: identityId(),
    componentId: integer('component_id')
      .notNull()
      .references(() => components.id, { onDelete: 'cascade' }),
    assetId: integer('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    assignedQty: integer('assigned_qty').notNull().default(1),
    note: text('note'),
    createdBy: integer('created_by'),
    ...timestampsNoSoftDelete(),
  },
  (table) => [
    index('idx_components_assets_component_id').on(table.componentId),
    index('idx_components_assets_asset_id').on(table.assetId),
  ],
);

export const kits = pgTable('kits', {
  id: identityId(),
  name: varchar('name', { length: 255 }).notNull(),
  createdBy: integer('created_by'),
  ...timestampsNoSoftDelete(),
});

export const kitsModels = pgTable(
  'kits_models',
  {
    id: identityId(),
    kitId: integer('kit_id')
      .notNull()
      .references(() => kits.id, { onDelete: 'cascade' }),
    modelId: integer('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull().default(1),
  },
  (table) => [uniqueIndex('uq_kits_models').on(table.kitId, table.modelId)],
);

export const kitsLicenses = pgTable(
  'kits_licenses',
  {
    id: identityId(),
    kitId: integer('kit_id')
      .notNull()
      .references(() => kits.id, { onDelete: 'cascade' }),
    licenseId: integer('license_id')
      .notNull()
      .references(() => licenses.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull().default(1),
  },
  (table) => [uniqueIndex('uq_kits_licenses').on(table.kitId, table.licenseId)],
);

export const kitsConsumables = pgTable(
  'kits_consumables',
  {
    id: identityId(),
    kitId: integer('kit_id')
      .notNull()
      .references(() => kits.id, { onDelete: 'cascade' }),
    consumableId: integer('consumable_id')
      .notNull()
      .references(() => consumables.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull().default(1),
  },
  (table) => [uniqueIndex('uq_kits_consumables').on(table.kitId, table.consumableId)],
);

export const kitsAccessories = pgTable(
  'kits_accessories',
  {
    id: identityId(),
    kitId: integer('kit_id')
      .notNull()
      .references(() => kits.id, { onDelete: 'cascade' }),
    accessoryId: integer('accessory_id')
      .notNull()
      .references(() => accessories.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull().default(1),
  },
  (table) => [uniqueIndex('uq_kits_accessories').on(table.kitId, table.accessoryId)],
);

export const orders = pgTable(
  'orders',
  {
    id: identityId(),
    orderNumber: varchar('order_number', { length: 255 }).notNull(),
    supplierId: integer('supplier_id').references(() => suppliers.id, {
      onDelete: 'set null',
    }),
    companyId: integer('company_id').references(() => companies.id, {
      onDelete: 'set null',
    }),
    purchaseDate: date('purchase_date'),
    notes: text('notes'),
    createdBy: integer('created_by'),
    ...timestamps(),
  },
  (table) => [index('idx_orders_order_number').on(table.orderNumber)],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: identityId(),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    itemType: varchar('item_type', { length: 64 }).$type<PolymorphicItemType>().notNull(),
    itemId: integer('item_id').notNull(),
    quantity: integer('quantity').notNull().default(1),
    unitCost: numeric('unit_cost', { precision: 20, scale: 2 }),
    currency: varchar('currency', { length: 10 }),
    purchaseDate: date('purchase_date'),
    createdBy: integer('created_by'),
    ...timestamps(),
  },
  (table) => [index('idx_order_items_item').on(table.itemType, table.itemId)],
);

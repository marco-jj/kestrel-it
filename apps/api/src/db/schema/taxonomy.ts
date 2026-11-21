import type { CategoryType, DepreciationType } from '@kestrel-it/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { identityId, timestamps, timestampsNoSoftDelete } from './_helpers.js';
import { companies, users } from './identity.js';

export const locations = pgTable(
  'locations',
  {
    id: identityId(),
    name: varchar('name', { length: 255 }).notNull(),
    parentId: integer('parent_id').references((): AnyPgColumn => locations.id, {
      onDelete: 'set null',
    }),
    managerId: integer('manager_id').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    companyId: integer('company_id').references((): AnyPgColumn => companies.id, {
      onDelete: 'set null',
    }),
    currency: varchar('currency', { length: 10 }),
    address: varchar('address', { length: 255 }),
    address2: varchar('address2', { length: 255 }),
    city: varchar('city', { length: 100 }),
    state: varchar('state', { length: 100 }),
    country: varchar('country', { length: 100 }),
    zip: varchar('zip', { length: 20 }),
    phone: varchar('phone', { length: 50 }),
    fax: varchar('fax', { length: 50 }),
    image: varchar('image', { length: 255 }),
    tagColor: varchar('tag_color', { length: 20 }),
    ldapOu: varchar('ldap_ou', { length: 255 }),
    notes: text('notes'),
    createdBy: integer('created_by'),
    ...timestamps(),
  },
  (table) => [
    index('idx_locations_parent_id').on(table.parentId),
    index('idx_locations_company_id').on(table.companyId),
    index('idx_locations_manager_id').on(table.managerId),
  ],
);

export const departments = pgTable(
  'departments',
  {
    id: identityId(),
    name: varchar('name', { length: 255 }).notNull(),
    companyId: integer('company_id').references((): AnyPgColumn => companies.id, {
      onDelete: 'set null',
    }),
    locationId: integer('location_id').references((): AnyPgColumn => locations.id, {
      onDelete: 'set null',
    }),
    managerId: integer('manager_id').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    phone: varchar('phone', { length: 50 }),
    fax: varchar('fax', { length: 50 }),
    image: varchar('image', { length: 255 }),
    tagColor: varchar('tag_color', { length: 20 }),
    notes: text('notes'),
    createdBy: integer('created_by'),
    ...timestamps(),
  },
  (table) => [
    index('idx_departments_company_id').on(table.companyId),
    index('idx_departments_location_id').on(table.locationId),
    index('idx_departments_manager_id').on(table.managerId),
  ],
);

export const categories = pgTable(
  'categories',
  {
    id: identityId(),
    name: varchar('name', { length: 255 }).notNull(),
    categoryType: varchar('category_type', { length: 32 }).$type<CategoryType>().notNull(),
    eulaText: text('eula_text'),
    useDefaultEula: boolean('use_default_eula').notNull().default(false),
    requireAcceptance: boolean('require_acceptance').notNull().default(false),
    alertOnResponse: boolean('alert_on_response').notNull().default(false),
    checkinEmail: boolean('checkin_email').notNull().default(false),
    image: varchar('image', { length: 255 }),
    tagColor: varchar('tag_color', { length: 20 }),
    notes: text('notes'),
    createdBy: integer('created_by'),
    ...timestamps(),
  },
  (table) => [index('idx_categories_type').on(table.categoryType)],
);

export const manufacturers = pgTable(
  'manufacturers',
  {
    id: identityId(),
    name: varchar('name', { length: 255 }).notNull(),
    url: varchar('url', { length: 500 }),
    supportUrl: varchar('support_url', { length: 500 }),
    warrantyLookupUrl: varchar('warranty_lookup_url', { length: 500 }),
    supportPhone: varchar('support_phone', { length: 50 }),
    supportEmail: varchar('support_email', { length: 255 }),
    image: varchar('image', { length: 255 }),
    tagColor: varchar('tag_color', { length: 20 }),
    notes: text('notes'),
    createdBy: integer('created_by'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('uq_manufacturers_name')
      .on(table.name)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const suppliers = pgTable(
  'suppliers',
  {
    id: identityId(),
    name: varchar('name', { length: 255 }).notNull(),
    address: varchar('address', { length: 255 }),
    address2: varchar('address2', { length: 255 }),
    city: varchar('city', { length: 100 }),
    state: varchar('state', { length: 100 }),
    country: varchar('country', { length: 100 }),
    zip: varchar('zip', { length: 20 }),
    contact: varchar('contact', { length: 255 }),
    phone: varchar('phone', { length: 50 }),
    fax: varchar('fax', { length: 50 }),
    email: varchar('email', { length: 255 }),
    url: varchar('url', { length: 500 }),
    image: varchar('image', { length: 255 }),
    tagColor: varchar('tag_color', { length: 20 }),
    notes: text('notes'),
    createdBy: integer('created_by'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('uq_suppliers_name')
      .on(table.name)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const statusLabels = pgTable('status_labels', {
  id: identityId(),
  name: varchar('name', { length: 255 }).notNull(),
  deployable: boolean('deployable').notNull().default(false),
  pending: boolean('pending').notNull().default(false),
  archived: boolean('archived').notNull().default(false),
  color: varchar('color', { length: 20 }),
  showInNav: boolean('show_in_nav').notNull().default(false),
  defaultLabel: boolean('default_label').notNull().default(false),
  notes: text('notes'),
  createdBy: integer('created_by'),
  ...timestamps(),
});

export const depreciations = pgTable('depreciations', {
  id: identityId(),
  name: varchar('name', { length: 255 }).notNull(),
  months: integer('months').notNull(),
  depreciationMin: numeric('depreciation_min', { precision: 20, scale: 2 }),
  depreciationType: varchar('depreciation_type', { length: 20 })
    .$type<DepreciationType>()
    .notNull()
    .default('amount'),
  fiscalYearStartMonth: integer('fiscal_year_start_month').default(1),
  rateMultiplier: numeric('rate_multiplier', { precision: 5, scale: 2 }),
  createdBy: integer('created_by'),
  ...timestampsNoSoftDelete(),
});

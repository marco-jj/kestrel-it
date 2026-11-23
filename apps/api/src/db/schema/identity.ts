import type { PermissionMap, WebhookProvider } from '@kestrel-it/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { identityId, timestamps, timestampsNoSoftDelete } from './_helpers.js';
import { departments, locations } from './taxonomy.js';

export const companies = pgTable(
  'companies',
  {
    id: identityId(),
    name: varchar('name', { length: 255 }).notNull(),
    parentId: integer('parent_id').references((): AnyPgColumn => companies.id, {
      onDelete: 'set null',
    }),
    tagColor: varchar('tag_color', { length: 20 }),
    fax: varchar('fax', { length: 50 }),
    email: varchar('email', { length: 150 }),
    phone: varchar('phone', { length: 50 }),
    image: varchar('image', { length: 255 }),
    notes: text('notes'),
    webhookSelected: varchar('webhook_selected', { length: 32 }).$type<WebhookProvider>(),
    webhookEndpoint: varchar('webhook_endpoint', { length: 500 }),
    webhookChannel: varchar('webhook_channel', { length: 255 }),
    webhookBotname: varchar('webhook_botname', { length: 255 }),
    createdBy: integer('created_by'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('uq_companies_name_parent')
      .on(table.name, table.parentId)
      .where(sql`${table.deletedAt} IS NULL`),
    index('idx_companies_parent_id').on(table.parentId),
  ],
);

export const users = pgTable(
  'users',
  {
    id: identityId(),
    username: varchar('username', { length: 255 }).notNull(),
    password: varchar('password', { length: 255 }),
    email: varchar('email', { length: 255 }),
    firstName: varchar('first_name', { length: 255 }),
    lastName: varchar('last_name', { length: 255 }),
    displayName: varchar('display_name', { length: 255 }),
    permissions: jsonb('permissions').$type<PermissionMap>().notNull().default({}),
    activated: boolean('activated').notNull().default(false),
    inventoryOnly: boolean('inventory_only').notNull().default(false),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    lastLogin: timestamp('last_login', { withTimezone: true }),
    employeeNum: varchar('employee_num', { length: 255 }),
    jobtitle: varchar('jobtitle', { length: 255 }),
    phone: varchar('phone', { length: 50 }),
    mobile: varchar('mobile', { length: 50 }),
    address: varchar('address', { length: 255 }),
    city: varchar('city', { length: 100 }),
    state: varchar('state', { length: 100 }),
    country: varchar('country', { length: 100 }),
    zip: varchar('zip', { length: 20 }),
    website: varchar('website', { length: 255 }),
    avatar: varchar('avatar', { length: 255 }),
    notes: text('notes'),
    locationId: integer('location_id').references((): AnyPgColumn => locations.id, {
      onDelete: 'set null',
    }),
    departmentId: integer('department_id').references((): AnyPgColumn => departments.id, {
      onDelete: 'set null',
    }),
    managerId: integer('manager_id').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    legacyCompanyId: integer('legacy_company_id').references((): AnyPgColumn => companies.id, {
      onDelete: 'set null',
    }),
    locale: varchar('locale', { length: 20 }).notNull().default('en-US'),
    skin: varchar('skin', { length: 50 }),
    twoFactorSecret: text('two_factor_secret'),
    twoFactorEnrolled: boolean('two_factor_enrolled').notNull().default(false),
    twoFactorOptin: boolean('two_factor_optin').notNull().default(false),
    oidcIssuer: varchar('oidc_issuer', { length: 500 }),
    oidcSubject: varchar('oidc_subject', { length: 255 }),
    scimExternalid: varchar('scim_externalid', { length: 255 }),
    remote: boolean('remote').notNull().default(false),
    vip: boolean('vip').notNull().default(false),
    autoassignLicenses: boolean('autoassign_licenses').notNull().default(true),
    showInList: boolean('show_in_list').notNull().default(true),
    startDate: date('start_date'),
    endDate: date('end_date'),
    enableSounds: boolean('enable_sounds').notNull().default(false),
    enableConfetti: boolean('enable_confetti').notNull().default(false),
    createdBy: integer('created_by'),
    ...timestamps(),
  },
  (table) => [
    index('idx_users_username').on(table.username),
    index('idx_users_email').on(table.email),
    uniqueIndex('uq_users_active_oidc')
      .on(table.oidcIssuer, table.oidcSubject)
      .where(sql`${table.deletedAt} IS NULL AND ${table.oidcIssuer} IS NOT NULL AND ${table.oidcSubject} IS NOT NULL`),
    index('idx_users_location_id').on(table.locationId),
    index('idx_users_department_id').on(table.departmentId),
    index('idx_users_manager_id').on(table.managerId),
  ],
);

export const companyUser = pgTable(
  'company_user',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.companyId] }),
    index('idx_company_user_company_id').on(table.companyId),
  ],
);

export const groups = pgTable(
  'groups',
  {
    id: identityId(),
    name: varchar('name', { length: 255 }).notNull(),
    permissions: jsonb('permissions').$type<PermissionMap>().notNull().default({}),
    notes: text('notes'),
    scimExternalid: varchar('scim_externalid', { length: 255 }),
    createdBy: integer('created_by'),
    ...timestampsNoSoftDelete(),
  },
  (table) => [uniqueIndex('uq_groups_name').on(table.name)],
);

export const usersGroups = pgTable(
  'users_groups',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.groupId] })],
);

export const personalAccessTokens = pgTable(
  'personal_access_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_pat_token_hash').on(table.tokenHash),
    index('idx_pat_user_id').on(table.userId),
  ],
);

export const authConsumedTokens = pgTable(
  'auth_consumed_tokens',
  {
    digest: varchar('digest', { length: 128 }).primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('idx_auth_consumed_tokens_expires').on(table.expiresAt)],
);

export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: identityId(),
    username: varchar('username', { length: 255 }),
    remoteIp: varchar('remote_ip', { length: 64 }),
    userAgent: text('user_agent'),
    successful: boolean('successful').notNull().default(false),
    loginVia: varchar('login_via', { length: 50 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_login_attempts_created_at').on(table.createdAt)],
);

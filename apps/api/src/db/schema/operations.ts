import type {
  ActionSource,
  CheckoutRequestState,
  DepreciationMethod,
  PolymorphicItemType,
  TwoFactorPolicy,
  WebhookProvider,
} from '@kestrel-it/shared';
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
import { assets } from './assets.js';
import { companies, users } from './identity.js';
import { orderItems } from './secondary-inventory.js';
import { locations, suppliers } from './taxonomy.js';

export const actionLogs = pgTable(
  'action_logs',
  {
    id: identityId(),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    actionType: varchar('action_type', { length: 100 }).notNull(),
    itemType: varchar('item_type', { length: 64 }).notNull(),
    itemId: integer('item_id').notNull(),
    targetType: varchar('target_type', { length: 64 }),
    targetId: integer('target_id'),
    locationId: integer('location_id').references(() => locations.id, { onDelete: 'set null' }),
    companyId: integer('company_id').references(() => companies.id, { onDelete: 'set null' }),
    quantity: integer('quantity').notNull().default(1),
    orderItemId: integer('order_item_id').references(() => orderItems.id, {
      onDelete: 'set null',
    }),
    note: text('note'),
    filename: varchar('filename', { length: 255 }),
    expectedCheckin: date('expected_checkin'),
    acceptedId: integer('accepted_id'),
    acceptSignature: varchar('accept_signature', { length: 255 }),
    storedEula: text('stored_eula'),
    logMeta: jsonb('log_meta').$type<Record<string, unknown>>(),
    actionDate: timestamp('action_date', { withTimezone: true }),
    actionSource: varchar('action_source', { length: 32 }).$type<ActionSource>(),
    remoteIp: varchar('remote_ip', { length: 64 }),
    userAgent: text('user_agent'),
    threadId: integer('thread_id'),
    ...timestamps(),
  },
  (table) => [
    index('idx_action_logs_item').on(table.itemType, table.itemId),
    index('idx_action_logs_target').on(table.targetType, table.targetId),
    index('idx_action_logs_action_type').on(table.actionType),
    index('idx_action_logs_company_id').on(table.companyId),
    index('idx_action_logs_created_at').on(table.createdAt),
  ],
);

export const checkoutAcceptances = pgTable(
  'checkout_acceptances',
  {
    id: identityId(),
    checkoutableType: varchar('checkoutable_type', { length: 64 })
      .$type<PolymorphicItemType>()
      .notNull(),
    checkoutableId: integer('checkoutable_id').notNull(),
    assignedToId: integer('assigned_to_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    qty: integer('qty'),
    signatureFilename: varchar('signature_filename', { length: 255 }),
    storedEula: text('stored_eula'),
    storedEulaFile: varchar('stored_eula_file', { length: 255 }),
    note: text('note'),
    alertOnResponseId: integer('alert_on_response_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    index('idx_checkout_acceptances_item').on(table.checkoutableType, table.checkoutableId),
    index('idx_checkout_acceptances_assigned_to').on(table.assignedToId),
  ],
);

export const checkoutRequests = pgTable(
  'checkout_requests',
  {
    id: identityId(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestableType: varchar('requestable_type', { length: 64 })
      .$type<PolymorphicItemType>()
      .notNull(),
    requestableId: integer('requestable_id').notNull(),
    quantity: integer('quantity').notNull().default(1),
    fulfilledQuantity: integer('fulfilled_quantity').notNull().default(0),
    state: varchar('state', { length: 32 })
      .$type<CheckoutRequestState>()
      .notNull()
      .default('pending'),
    startDate: date('start_date'),
    endDate: date('end_date'),
    notes: text('notes'),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
    fulfilledBy: integer('fulfilled_by').references(() => users.id, { onDelete: 'set null' }),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    checkoutActionlogId: integer('checkout_actionlog_id').references(() => actionLogs.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (table) => [
    index('idx_checkout_requests_user_id').on(table.userId),
    index('idx_checkout_requests_item').on(table.requestableType, table.requestableId),
    index('idx_checkout_requests_state').on(table.state),
  ],
);

export const maintenanceTypes = pgTable('maintenance_types', {
  id: identityId(),
  name: varchar('name', { length: 255 }).notNull(),
  isSystem: boolean('is_system').notNull().default(false),
  ...timestamps(),
});

export const assetMaintenances = pgTable(
  'asset_maintenances',
  {
    id: identityId(),
    itemId: integer('item_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    itemType: varchar('item_type', { length: 64 })
      .$type<PolymorphicItemType>()
      .notNull()
      .default('asset'),
    supplierId: integer('supplier_id').references(() => suppliers.id, {
      onDelete: 'set null',
    }),
    maintenanceTypeId: integer('maintenance_type_id').references(() => maintenanceTypes.id, {
      onDelete: 'set null',
    }),
    assetMaintenanceType: varchar('asset_maintenance_type', { length: 100 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    url: varchar('url', { length: 500 }),
    isWarranty: boolean('is_warranty').notNull().default(false),
    startDate: date('start_date').notNull(),
    expectedCompletionDate: date('expected_completion_date'),
    completedAt: date('completed_at'),
    completedBy: integer('completed_by').references(() => users.id, { onDelete: 'set null' }),
    assetMaintenanceTime: integer('asset_maintenance_time'),
    cost: numeric('cost', { precision: 20, scale: 2 }),
    checkedOutToId: integer('checked_out_to_id'),
    checkedOutToType: varchar('checked_out_to_type', { length: 32 }),
    responsiblePartyId: integer('responsible_party_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    image: varchar('image', { length: 255 }),
    notes: text('notes'),
    createdBy: integer('created_by'),
    ...timestamps(),
  },
  (table) => [
    index('idx_maintenances_item').on(table.itemType, table.itemId),
    index('idx_maintenances_supplier_id').on(table.supplierId),
    index('idx_maintenances_completed_at').on(table.completedAt),
  ],
);

export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: identityId(),
    sourceType: varchar('source_type', { length: 64 }).$type<PolymorphicItemType>().notNull(),
    sourceId: integer('source_id').notNull(),
    sourceField: varchar('source_field', { length: 64 }).notNull(),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    start: timestamp('start', { withTimezone: true }).notNull(),
    end: timestamp('end', { withTimezone: true }),
    companyId: integer('company_id').references(() => companies.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('uq_calendar_events_source').on(
      table.sourceType,
      table.sourceId,
      table.sourceField,
    ),
    index('idx_calendar_events_range').on(table.start, table.end),
    index('idx_calendar_events_company_id').on(table.companyId),
  ],
);

export const imports = pgTable('imports', {
  id: identityId(),
  name: varchar('name', { length: 255 }),
  filePath: varchar('file_path', { length: 500 }).notNull(),
  filesize: integer('filesize').notNull(),
  importType: varchar('import_type', { length: 64 }),
  headerRow: jsonb('header_row').$type<string[]>(),
  firstRow: jsonb('first_row').$type<Record<string, unknown> | string[]>(),
  fieldMap: jsonb('field_map').$type<Record<string, string>>(),
  processingBy: integer('processing_by').references(() => users.id, { onDelete: 'set null' }),
  processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
  createdBy: integer('created_by'),
  ...timestampsNoSoftDelete(),
});

export const reportTemplates = pgTable('report_templates', {
  id: identityId(),
  name: varchar('name', { length: 255 }).notNull(),
  options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
});

export const savedSearches = pgTable(
  'saved_searches',
  {
    id: identityId(),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tableName: varchar('table_name', { length: 100 }).notNull(),
    model: varchar('model', { length: 100 }),
    name: varchar('name', { length: 255 }).notNull(),
    queryString: text('query_string').notNull(),
    ...timestampsNoSoftDelete(),
  },
  (table) => [index('idx_saved_searches_owner_table').on(table.createdBy, table.tableName)],
);

export const customUserLabels = pgTable('custom_user_labels', {
  id: identityId(),
  name: varchar('name', { length: 255 }).notNull(),
  baseLabel: varchar('base_label', { length: 100 }),
  type: varchar('type', { length: 64 }).notNull(),
  overrides: jsonb('overrides').$type<Record<string, unknown>>(),
  configSnapshot: jsonb('config_snapshot').$type<Record<string, unknown>>(),
  isDefault: boolean('is_default').notNull().default(false),
  ...timestamps(),
});

export const settings = pgTable('settings', {
  id: identityId(),
  perPage: integer('per_page').notNull().default(20),
  siteName: varchar('site_name', { length: 255 }).notNull().default('Kestrel-IT'),
  qrCode: boolean('qr_code').notNull().default(true),
  qrText: varchar('qr_text', { length: 255 }),
  displayAssetName: boolean('display_asset_name').notNull().default(true),
  displayCheckoutDate: boolean('display_checkout_date').notNull().default(false),
  displayEol: boolean('display_eol').notNull().default(false),
  autoIncrementAssets: boolean('auto_increment_assets').notNull().default(false),
  autoIncrementPrefix: varchar('auto_increment_prefix', { length: 100 }),
  nextAutoTagBase: integer('next_auto_tag_base').notNull().default(1),
  zerofillCount: integer('zerofill_count').notNull().default(5),
  uniqueSerial: boolean('unique_serial').notNull().default(false),
  loadRemote: boolean('load_remote').notNull().default(true),
  logo: varchar('logo', { length: 255 }),
  favicon: varchar('favicon', { length: 255 }),
  defaultAvatar: varchar('default_avatar', { length: 255 }),
  emailLogo: varchar('email_logo', { length: 255 }),
  labelLogo: varchar('label_logo', { length: 255 }),
  acceptancePdfLogo: varchar('acceptance_pdf_logo', { length: 255 }),
  headerColor: varchar('header_color', { length: 32 }),
  navLinkColor: varchar('nav_link_color', { length: 32 }).default('#FFFFFF'),
  linkLightColor: varchar('link_light_color', { length: 32 }).default('#296282'),
  linkDarkColor: varchar('link_dark_color', { length: 32 }).default('#296282'),
  customCss: text('custom_css'),
  brand: integer('brand').notNull().default(1),
  skin: varchar('skin', { length: 50 }),
  allowUserSkin: boolean('allow_user_skin').notNull().default(true),
  supportFooter: varchar('support_footer', { length: 20 }).default('on'),
  versionFooter: varchar('version_footer', { length: 20 }).default('on'),
  footerText: text('footer_text'),
  privacyPolicyLink: varchar('privacy_policy_link', { length: 500 }),
  dashboardMessage: text('dashboard_message'),
  loginNote: text('login_note'),
  defaultCurrency: varchar('default_currency', { length: 10 }).default('USD'),
  locale: varchar('locale', { length: 20 }).notNull().default('en-US'),
  weekStart: integer('week_start').default(1),
  dateDisplayFormat: varchar('date_display_format', { length: 50 }).notNull().default('Y-m-d'),
  timeDisplayFormat: varchar('time_display_format', { length: 50 }).notNull().default('H:i'),
  digitSeparator: varchar('digit_separator', { length: 20 }).default('1,234.56'),
  nameDisplayFormat: varchar('name_display_format', { length: 32 }).default('first_last'),
  emailDomain: varchar('email_domain', { length: 255 }),
  emailFormat: varchar('email_format', { length: 50 }),
  usernameFormat: varchar('username_format', { length: 50 }),
  // Multi-company (FMCS)
  fullMultipleCompaniesSupport: boolean('full_multiple_companies_support')
    .notNull()
    .default(false),
  scopeLocationsFmcs: boolean('scope_locations_fmcs').notNull().default(false),
  nullCompanyIsFloater: boolean('null_company_is_floater').notNull().default(false),
  // Alerts & Audits
  alertsEnabled: boolean('alerts_enabled').notNull().default(true),
  alertEmail: varchar('alert_email', { length: 255 }),
  adminCcEmail: varchar('admin_cc_email', { length: 255 }),
  adminCcAlways: boolean('admin_cc_always').notNull().default(false),
  alertInterval: integer('alert_interval').default(30),
  alertThreshold: integer('alert_threshold').default(5),
  auditInterval: integer('audit_interval'),
  auditWarningDays: integer('audit_warning_days').default(14),
  dueCheckinDays: integer('due_checkin_days').default(7),
  showAlertsInMenu: boolean('show_alerts_in_menu').notNull().default(true),
  showImagesInEmail: boolean('show_images_in_email').notNull().default(true),
  showUrlInEmails: boolean('show_url_in_emails').notNull().default(true),
  // EULA, Checkout & Depreciation
  defaultEulaText: text('default_eula_text'),
  requireAcceptSignature: boolean('require_accept_signature').notNull().default(false),
  requireCheckinoutNotes: boolean('require_checkinout_notes').notNull().default(false),
  requireAdjustQuantityNotes: boolean('require_adjust_quantity_notes').notNull().default(false),
  depreciationMethod: varchar('depreciation_method', { length: 32 })
    .$type<DepreciationMethod>()
    .default('default'),
  // Security & Auth
  twoFactorEnabled: integer('two_factor_enabled')
    .$type<TwoFactorPolicy>()
    .notNull()
    .default(0),
  pwdSecureMin: integer('pwd_secure_min').notNull().default(10),
  pwdSecureComplexity: varchar('pwd_secure_complexity', { length: 255 }),
  pwdSecureUncommon: boolean('pwd_secure_uncommon').notNull().default(false),
  profileEdit: boolean('profile_edit').notNull().default(true),
  managerViewEnabled: boolean('manager_view_enabled').notNull().default(false),
  showAssignedAssets: boolean('show_assigned_assets').notNull().default(false),
  showArchivedInList: boolean('show_archived_in_list').notNull().default(false),
  shortcutsEnabled: boolean('shortcuts_enabled').notNull().default(false),
  dashChartType: varchar('dash_chart_type', { length: 32 }).default('doughnut'),
  thumbnailMaxH: integer('thumbnail_max_h').default(50),
  // OIDC & JIT Auto-Provisioning
  oidcEnabled: boolean('oidc_enabled').notNull().default(false),
  oidcIssuerUrl: varchar('oidc_issuer_url', { length: 500 }),
  oidcClientId: varchar('oidc_client_id', { length: 255 }),
  oidcClientSecretEncrypted: text('oidc_client_secret_encrypted'),
  oidcScopes: varchar('oidc_scopes', { length: 255 }).default('openid profile email groups'),
  oidcAutoProvisionUsers: boolean('oidc_auto_provision_users').notNull().default(true),
  oidcLinkExistingUsers: boolean('oidc_link_existing_users').notNull().default(true),
  oidcSyncOnLogin: boolean('oidc_sync_on_login').notNull().default(true),
  oidcSyncGroups: boolean('oidc_sync_groups').notNull().default(true),
  oidcUsernameClaim: varchar('oidc_username_claim', { length: 100 }).default('preferred_username'),
  oidcGroupsClaim: varchar('oidc_groups_claim', { length: 100 }).default('groups'),
  oidcDefaultGroupId: integer('oidc_default_group_id'),
  oidcDefaultCompanyId: integer('oidc_default_company_id'),
  oidcGroupMapping: jsonb('oidc_group_mapping').$type<Record<string, number>>().default({}),
  // Webhooks
  webhookSelected: varchar('webhook_selected', { length: 32 }).$type<WebhookProvider>(),
  webhookEndpoint: varchar('webhook_endpoint', { length: 500 }),
  webhookChannel: varchar('webhook_channel', { length: 255 }),
  webhookBotname: varchar('webhook_botname', { length: 255 }),
  // Labels & Barcodes
  altBarcodeEnabled: boolean('alt_barcode_enabled').notNull().default(true),
  labelsPerPage: integer('labels_per_page').notNull().default(30),
  labelsWidth: numeric('labels_width', { precision: 8, scale: 3 }).notNull().default('2.625'),
  labelsHeight: numeric('labels_height', { precision: 8, scale: 3 }).notNull().default('1.000'),
  labelsPmarginLeft: numeric('labels_pmargin_left', { precision: 8, scale: 3 })
    .notNull()
    .default('0.188'),
  labelsPmarginRight: numeric('labels_pmargin_right', { precision: 8, scale: 3 })
    .notNull()
    .default('0.188'),
  labelsPmarginTop: numeric('labels_pmargin_top', { precision: 8, scale: 3 })
    .notNull()
    .default('0.500'),
  labelsPmarginBottom: numeric('labels_pmargin_bottom', { precision: 8, scale: 3 })
    .notNull()
    .default('0.500'),
  labelsDisplayBgutter: numeric('labels_display_bgutter', { precision: 8, scale: 3 })
    .notNull()
    .default('0.125'),
  labelsDisplaySgutter: numeric('labels_display_sgutter', { precision: 8, scale: 3 })
    .notNull()
    .default('0.000'),
  labelsFontsize: integer('labels_fontsize').notNull().default(9),
  labelsPagewidth: numeric('labels_pagewidth', { precision: 8, scale: 3 })
    .notNull()
    .default('8.500'),
  labelsPageheight: numeric('labels_pageheight', { precision: 8, scale: 3 })
    .notNull()
    .default('11.000'),
  labelsDisplayName: boolean('labels_display_name').notNull().default(true),
  labelsDisplaySerial: boolean('labels_display_serial').notNull().default(true),
  labelsDisplayTag: boolean('labels_display_tag').notNull().default(true),
  labelsDisplayModel: boolean('labels_display_model').notNull().default(false),
  labelsDisplayCompanyName: boolean('labels_display_company_name').notNull().default(false),
  label2Enable: boolean('label2_enable').notNull().default(false),
  label2Template: varchar('label2_template', { length: 100 }),
  label2Title: varchar('label2_title', { length: 255 }),
  label2AssetLogo: boolean('label2_asset_logo').notNull().default(false),
  label21dType: varchar('label2_1d_type', { length: 32 }).notNull().default('C128'),
  label22dType: varchar('label2_2d_type', { length: 32 }).notNull().default('QRCODE'),
  label22dPrefix: varchar('label2_2d_prefix', { length: 255 }),
  label22dTarget: varchar('label2_2d_target', { length: 64 }).notNull().default('hardware_id'),
  label2Fields: jsonb('label2_fields').$type<string[]>().notNull().default([]),
  label2EmptyRowCount: integer('label2_empty_row_count').notNull().default(0),
  createdBy: integer('created_by'),
  ...timestampsNoSoftDelete(),
});

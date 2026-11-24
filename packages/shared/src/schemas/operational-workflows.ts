import { z } from 'zod';
import { DatatableQuerySchema } from './api-envelopes.js';
import { InventoryIdSchema } from './core-inventory.js';

export const IMPORT_TYPES = [
  'asset',
  'assetHistory',
  'assetModel',
  'user',
  'license',
  'accessory',
  'consumable',
  'component',
  'location',
  'category',
  'manufacturer',
  'supplier',
] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

export const ImportProcessSchema = z.object({
  import_type: z.enum(IMPORT_TYPES),
  field_map: z.record(z.string().min(1).max(200).nullable()),
  update_existing: z.boolean().default(false),
  preserve_blanks: z.boolean().default(false),
  send_welcome: z.boolean().default(false),
});

export const REPORT_TYPES = [
  'activity',
  'custom',
  'custom-components',
  'custom-consumables',
  'depreciation',
  'licenses',
  'maintenances',
  'unaccepted-assets',
  'accessories',
  'audit',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const ReportQuerySchema = DatatableQuerySchema.extend({
  format: z.enum(['csv', 'xlsx']).optional(),
  columns: z.string().max(5000).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  as_of: z.string().date().optional(),
  company_id: InventoryIdSchema.optional(),
  model_id: InventoryIdSchema.optional(),
  category_id: InventoryIdSchema.optional(),
  location_id: InventoryIdSchema.optional(),
  status_id: InventoryIdSchema.optional(),
  supplier_id: InventoryIdSchema.optional(),
  item_type: z.string().max(64).optional(),
  action_type: z.string().max(100).optional(),
  date_field: z
    .enum(['purchase_date', 'last_checkout', 'last_checkin', 'updated_at', 'expiration_date'])
    .optional(),
  assigned: z.enum(['yes', 'no']).optional(),
  scoped: z.enum(['true', 'false']).optional(),
});

export const LabelLayoutSchema = z.object({
  type: z.enum(['sheet', 'roll']).default('sheet'),
  units: z.enum(['in', 'mm']).default('in'),
  width: z.number().positive().max(1000),
  height: z.number().positive().max(1000),
  page_width: z.number().positive().max(1000),
  page_height: z.number().positive().max(1000),
  margin_x: z.number().nonnegative().max(500).default(0),
  margin_y: z.number().nonnegative().max(500).default(0),
  gap_x: z.number().nonnegative().max(500).default(0),
  gap_y: z.number().nonnegative().max(500).default(0),
  skipped: z.number().int().min(0).max(100).default(0),
  font_size: z.number().min(4).max(28).default(8),
  title: z.string().max(80).default(''),
  barcode: z.enum(['none', 'C128', 'C39', 'EAN13', 'UPCA', 'ITF']).default('C128'),
  code2d: z.enum(['none', 'QRCODE', 'DATAMATRIX', 'PDF417']).default('QRCODE'),
  prefix: z.string().max(255).default(''),
  target: z.enum(['hardware_id', 'asset_tag']).default('hardware_id'),
  fields: z.array(z.string().max(160)).max(12).default(['asset_tag', 'name']),
});
export type LabelLayout = z.output<typeof LabelLayoutSchema>;

const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{3,8}$/, 'Use a hex color code such as #0D9488');

const httpUrlSchema = z.string().trim().url().max(500).refine(
  (value) => /^https?:\/\//i.test(value),
  'Use an HTTP or HTTPS URL',
);

export const GeneralSettingsUpdateSchema = z
  .object({
    site_name: z.string().trim().min(1).max(255).optional(),
    per_page: z.coerce.number().int().min(5).max(500).optional(),
    locale: z.string().trim().min(2).max(20).optional(),
    default_currency: z.string().trim().min(1).max(10).optional(),
    date_display_format: z.string().trim().min(1).max(50).optional(),
    time_display_format: z.string().trim().min(1).max(50).optional(),
    auto_increment_assets: z.boolean().optional(),
    auto_increment_prefix: z.string().trim().max(100).nullable().optional(),
    zerofill_count: z.coerce.number().int().min(0).max(20).optional(),
    unique_serial: z.boolean().optional(),
    full_multiple_companies_support: z.boolean().optional(),
    scope_locations_fmcs: z.boolean().optional(),
    null_company_is_floater: z.boolean().optional(),
    default_eula_text: z.string().max(50_000).nullable().optional(),
    require_accept_signature: z.boolean().optional(),
    require_checkinout_notes: z.boolean().optional(),
    require_adjust_quantity_notes: z.boolean().optional(),
    depreciation_method: z.enum(['default', 'half_1', 'half_2', 'diminish']).optional(),
    two_factor_enabled: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    pwd_secure_min: z.coerce.number().int().min(8).max(128).optional(),
    profile_edit: z.boolean().optional(),
    show_assigned_assets: z.boolean().optional(),
    show_archived_in_list: z.boolean().optional(),
    dash_chart_type: z.enum(['doughnut', 'bar', 'pie', 'horizontalBar']).optional(),
    header_color: hexColorSchema.nullable().optional(),
    nav_link_color: hexColorSchema.nullable().optional(),
    link_light_color: hexColorSchema.nullable().optional(),
    link_dark_color: hexColorSchema.nullable().optional(),
    custom_css: z.string().max(50_000).nullable().optional(),
    footer_text: z.string().max(10_000).nullable().optional(),
    privacy_policy_link: httpUrlSchema.nullable().optional(),
    dashboard_message: z.string().max(10_000).nullable().optional(),
    login_note: z.string().max(10_000).nullable().optional(),
    oidc_enabled: z.boolean().optional(),
    oidc_issuer_url: httpUrlSchema.nullable().optional(),
    oidc_client_id: z.string().trim().max(255).nullable().optional(),
    oidc_client_secret: z.string().max(500).nullable().optional(),
    oidc_scopes: z.string().trim().max(255).nullable().optional(),
    oidc_auto_provision_users: z.boolean().optional(),
    oidc_link_existing_users: z.boolean().optional(),
    oidc_sync_on_login: z.boolean().optional(),
    oidc_sync_groups: z.boolean().optional(),
    oidc_username_claim: z.string().trim().max(100).nullable().optional(),
    oidc_groups_claim: z.string().trim().max(100).nullable().optional(),
  })
  .strict();
export type GeneralSettingsUpdate = z.infer<typeof GeneralSettingsUpdateSchema>;

export const AccountProfileUpdateSchema = z
  .object({
    first_name: z.string().trim().max(255).nullable().optional(),
    last_name: z.string().trim().max(255).nullable().optional(),
    display_name: z.string().trim().max(255).nullable().optional(),
    email: z.string().trim().email().max(255).nullable().optional(),
    locale: z.string().trim().min(2).max(20).optional(),
    phone: z.string().trim().max(50).nullable().optional(),
    current_password: z.string().min(1).max(255).optional(),
    new_password: z.string().min(8).max(255).optional(),
  })
  .strict()
  .refine((input) => !input.new_password || Boolean(input.current_password), {
    path: ['current_password'],
    message: 'Current password is required to set a new password',
  });
export type AccountProfileUpdate = z.infer<typeof AccountProfileUpdateSchema>;

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

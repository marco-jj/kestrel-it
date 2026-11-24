import { z } from 'zod';
import { CustomFieldValuesSchema } from './inventory-custom-fields.js';
import { InventoryIdSchema } from './core-inventory.js';

export const SECONDARY_RESOURCES = [
  'licenses',
  'accessories',
  'consumables',
  'components',
] as const;
export type SecondaryResource = (typeof SECONDARY_RESOURCES)[number];
export const KIT_RESOURCES = ['models', 'licenses', 'accessories', 'consumables'] as const;
export type KitResource = (typeof KIT_RESOURCES)[number];

export const inventoryQuantity = z.coerce.number().int().min(0).max(2147483647);
export const assignmentQuantity = z.coerce.number().int().min(1).max(1000);
export const inventoryName = z.string().trim().min(1).max(255);
export const inventoryNote = z.string().trim().max(10000).nullable().optional();
export const inventoryMoney = z
  .union([z.string(), z.number()])
  .transform(String)
  .pipe(z.string().regex(/^\d{1,18}(\.\d{1,2})?$/));
const reference = InventoryIdSchema.nullable().optional();
const text = z.string().trim().max(255).nullable().optional();
const date = z.string().date().nullable().optional();
const sharedCatalog = {
  name: inventoryName,
  company_id: reference,
  manufacturer_id: reference,
  category_id: reference,
  min_amt: inventoryQuantity.nullable().optional(),
  requestable: z.boolean().optional(),
  notes: inventoryNote,
};
const stockCatalog = z.object({
  ...sharedCatalog,
  location_id: reference,
  default_supplier_id: reference,
  model_number: text,
  qty: inventoryQuantity.optional(),
  default_purchase_cost: inventoryMoney.nullable().optional(),
  legacy_order_number: text,
  legacy_purchase_date: date,
  archived: z.boolean().optional(),
});
export const SecondaryCatalogSchemas = {
  accessories: stockCatalog,
  consumables: stockCatalog.extend({ item_no: text }),
  components: stockCatalog.extend({ serial: text }),
  licenses: z.object({
    ...sharedCatalog,
    serial: z.string().max(8192).nullable().optional(),
    supplier_id: reference,
    depreciation_id: reference,
    seats: assignmentQuantity.optional(),
    purchase_date: date,
    purchase_cost: inventoryMoney.nullable().optional(),
    order_number: text,
    purchase_order: text,
    license_name: text,
    license_email: z.string().max(255).email().nullable().optional(),
    reassignable: z.boolean().optional(),
    maintained: z.boolean().optional(),
    depreciate: z.boolean().optional(),
    expiration_date: date,
    termination_date: date,
  }),
};

export const InventoryAssignmentSchema = z.object({
  target_type: z.enum(['user', 'asset', 'location']),
  target_id: InventoryIdSchema,
  quantity: assignmentQuantity.default(1),
  seat_id: InventoryIdSchema.optional(),
  reassign: z.boolean().optional(),
  note: inventoryNote,
});

export const StockAdjustmentSchema = z.object({
  amount: z.coerce
    .number()
    .int()
    .min(-2147483647)
    .max(2147483647)
    .refine((amount) => amount !== 0),
  note: inventoryNote,
  order_number: inventoryName.optional(),
  supplier_id: reference,
  unit_cost: inventoryMoney.nullable().optional(),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  purchase_date: date,
});

export const InventoryIdsSchema = z
  .array(InventoryIdSchema)
  .min(1)
  .max(100)
  .transform((ids) => [...new Set(ids)]);

export const AssetAuditSchema = z.object({
  next_audit_date: date,
  note: inventoryNote,
  location_id: reference,
  update_location: z
    .union([z.boolean(), z.enum(['0', '1']).transform((value) => value === '1')])
    .optional(),
  clear_name: z
    .union([z.boolean(), z.enum(['0', '1']).transform((value) => value === '1')])
    .optional(),
  custom_fields: CustomFieldValuesSchema.optional(),
  audit_by_field: z.enum(['asset_tag', 'serial']).optional(),
  audit_key: inventoryName.optional(),
  asset_tag: inventoryName.optional(),
  ids: InventoryIdsSchema.optional(),
});

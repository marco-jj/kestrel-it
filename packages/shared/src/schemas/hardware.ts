import { z } from 'zod';
import { DatatableQuerySchema } from './api-envelopes.js';
import { InventoryIdSchema } from './core-inventory.js';
import { CustomFieldValuesSchema } from './inventory-custom-fields.js';

const id = InventoryIdSchema.nullable().optional();
const text = (max = 255) => z.string().trim().max(max).nullable().optional();
const number = z.coerce.number().int().min(0).max(2_147_483_647).nullable().optional();
const date = z.string().date().nullable().optional();

export const AssetModelInputSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    model_number: text(),
    manufacturer_id: id,
    category_id: InventoryIdSchema,
    fieldset_id: id,
    depreciation_id: id,
    eol: number,
    min_amt: number,
    require_serial: z.boolean().optional(),
    requestable: z.boolean().optional(),
    notes: text(10_000),
  })
  .strict();

export const AssetInputSchema = z
  .object({
    name: text(),
    asset_tag: z.string().trim().min(1).max(255).nullable().optional(),
    model_id: InventoryIdSchema,
    status_id: InventoryIdSchema,
    serial: text(),
    company_id: id,
    supplier_id: id,
    location_id: id,
    rtd_location_id: id,
    purchase_date: date,
    purchase_cost: z
      .union([z.string(), z.number().finite()])
      .transform(String)
      .refine((value) => /^\d{1,18}(?:\.\d{1,2})?$/.test(value), 'Enter a valid cost')
      .nullable()
      .optional(),
    order_number: text(),
    warranty_months: number,
    asset_eol_date: date,
    requestable: z.boolean().optional(),
    byod: z.boolean().optional(),
    notes: text(10_000),
    custom_fields: CustomFieldValuesSchema.optional(),
  })
  .strict();

export const HardwareFilterSchema = z
  .object({
    model_id: InventoryIdSchema.optional(),
    company_id: InventoryIdSchema.optional(),
    category_id: InventoryIdSchema.optional(),
    supplier_id: InventoryIdSchema.optional(),
    status_id: InventoryIdSchema.optional(),
    location_id: InventoryIdSchema.optional(),
    rtd_location_id: InventoryIdSchema.optional(),
    manufacturer_id: InventoryIdSchema.optional(),
    status: z.enum(['deployable', 'deployed', 'pending', 'archived', 'undeployable']).optional(),
    tag: z.string().max(255).optional(),
    serial: z.string().max(255).optional(),
    requestable: z.enum(['0', '1']).optional(),
    deleted: z.enum(['0', '1']).optional(),
    custom_field: z.string().trim().max(120).optional(),
    custom_value: z.string().max(8_192).optional(),
  })
  .strict();
export const HardwareQuerySchema = DatatableQuerySchema.merge(HardwareFilterSchema);
export type HardwareQuery = z.infer<typeof HardwareQuerySchema>;
export const SavedSearchInputSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    query: HardwareFilterSchema.extend({
      search: z.string().max(255).optional(),
      sort: z.string().max(64).optional(),
      order: z.enum(['asc', 'desc']).optional(),
    }),
  })
  .strict();

import { z } from 'zod';
import { CUSTOM_FIELD_ELEMENTS } from '../enums/index.js';
import { InventoryIdSchema } from './core-inventory.js';

export const CustomFieldValuesSchema = z.record(
  z.union([
    z.string().max(8_192),
    z.number().finite(),
    z.boolean(),
    z.array(z.string().max(8_192)).max(100),
    z.null(),
  ]),
);

export const CustomFieldFormModeSchema = z.enum(['asset', 'checkout', 'checkin', 'audit']);
export type CustomFieldFormMode = z.infer<typeof CustomFieldFormModeSchema>;

export const CustomFieldInputSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    element: z.enum(CUSTOM_FIELD_ELEMENTS),
    format: z.string().trim().max(500).nullable().optional(),
    field_values: z.string().max(10_000).nullable().optional(),
    help_text: z.string().max(10_000).nullable().optional(),
    field_encrypted: z.boolean().optional(),
    is_unique: z.boolean().optional(),
    auto_add_to_fieldsets: z.boolean().optional(),
    show_in_listview: z.boolean().optional(),
    show_in_email: z.boolean().optional(),
    show_in_requestable_list: z.boolean().optional(),
    display_in_user_view: z.boolean().optional(),
    display_checkout: z.boolean().optional(),
    display_checkin: z.boolean().optional(),
    display_audit: z.boolean().optional(),
  })
  .strict();

export const CustomFieldsetInputSchema = z
  .object({ name: z.string().trim().min(1).max(255) })
  .strict();
export const CustomFieldAssociationSchema = z
  .object({
    field_id: InventoryIdSchema,
    required: z.boolean().default(false),
  })
  .strict();
export const CustomFieldOrderSchema = z
  .object({
    field_ids: z.array(InventoryIdSchema).max(250),
  })
  .strict();

export interface InventoryCustomField {
  id: number;
  name: string;
  db_column: string;
  element: (typeof CUSTOM_FIELD_ELEMENTS)[number];
  format: string | null;
  field_values: string | null;
  help_text: string | null;
  field_encrypted: boolean;
  required: boolean;
}

import { z } from 'zod';
import { CHECKOUT_TARGET_TYPES } from '../enums/index.js';
import { InventoryIdSchema } from './core-inventory.js';
import { CustomFieldValuesSchema } from './inventory-custom-fields.js';

const id = InventoryIdSchema.optional();
const note = z.string().trim().max(10_000).nullable().optional();
const date = z.string().date();
const timestamp = z.union([date, z.string().datetime({ offset: true })]).optional();
const boolean = z
  .union([z.boolean(), z.enum(['0', '1'])])
  .transform((value) => value === true || value === '1')
  .optional();

export const AssetCheckoutInputSchema = z
  .object({
    target_type: z.enum(CHECKOUT_TARGET_TYPES).optional(),
    target_id: id,
    checkout_to_type: z.enum(CHECKOUT_TARGET_TYPES).optional(),
    assigned_user: id,
    assigned_asset: id,
    assigned_location: id,
    checkout_at: timestamp,
    expected_checkin: date.nullable().optional(),
    name: z.string().trim().max(255).optional(),
    note,
    sign_in_place: boolean,
    custom_fields: CustomFieldValuesSchema.optional(),
  })
  .strict()
  .transform((dto, context) => {
    const type = dto.target_type ?? dto.checkout_to_type;
    const selected = {
      user: dto.assigned_user,
      asset: dto.assigned_asset,
      location: dto.assigned_location,
    };
    const target = dto.target_id ?? (type ? selected[type] : undefined);
    if (!type || target === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target_id'],
        message: 'Choose a checkout target',
      });
      return z.NEVER;
    }
    const {
      target_type,
      target_id,
      checkout_to_type,
      assigned_user,
      assigned_asset,
      assigned_location,
      ...values
    } = dto;
    return { ...values, target_type: type, target_id: target };
  });

export const AssetCheckinInputSchema = z
  .object({
    checkin_at: timestamp,
    location_id: InventoryIdSchema.nullable().optional(),
    status_id: id,
    asset_tag: z.string().trim().min(1).max(255).optional(),
    name: z.string().trim().max(255).optional(),
    clear_name: boolean,
    update_default_location: boolean,
    note,
    custom_fields: CustomFieldValuesSchema.optional(),
  })
  .strict();

export const AcceptanceResponseSchema = z
  .object({
    decision: z.enum(['accept', 'decline']),
    signature: z.string().max(700_000).optional(),
    note,
  })
  .strict();

export const RequestableTypeSchema = z.enum(['hardware', 'models']);
export const RequestableInputSchema = z
  .object({
    start_date: date.nullable().optional(),
    end_date: date.nullable().optional(),
    notes: note,
  })
  .strict()
  .refine((input) => !input.start_date || !input.end_date || input.end_date >= input.start_date, {
    path: ['end_date'],
    message: 'End date must be on or after start date',
  });

import { z } from 'zod';

/**
 * Standard query parameters for paginated list endpoints (Bootstrap Table / DataGrid).
 */
export const DatatableQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().min(1).optional(),
  search: z.string().trim().optional(),
  sort: z.string().trim().optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
});
export type DatatableQuery = z.infer<typeof DatatableQuerySchema>;

export interface DatatableResponse<T> {
  total: number;
  rows: T[];
  current_page: number;
  per_page: number;
  total_pages: number;
  prev_page_url: string | null;
  next_page_url: string | null;
}

/**
 * Builds a Zod schema for a paginated Datatable response wrapping a specific row schema.
 */
export function createDatatableResponseSchema<T extends z.ZodTypeAny>(rowSchema: T) {
  return z.object({
    total: z.number().int().nonnegative(),
    rows: z.array(rowSchema),
    current_page: z.number().int().positive(),
    per_page: z.number().int().positive(),
    total_pages: z.number().int().nonnegative(),
    prev_page_url: z.string().nullable(),
    next_page_url: z.string().nullable(),
  });
}

/**
 * Standard query parameters for asynchronous dropdown selectlist endpoints.
 */
export const SelectlistQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().optional(),
  // Zero selects compatible unassigned records. Omission leaves the actor's scope unchanged.
  companyId: z
    .union([
      z.literal(0),
      z.literal('0').transform(() => 0),
      z.coerce.number().int().positive().max(2_147_483_647),
    ])
    .optional(),
  statusType: z.string().trim().optional(),
  includeNull: z
    .union([z.boolean(), z.enum(['0', '1', 'true', 'false'])])
    .transform((v) => v === true || v === '1' || v === 'true')
    .optional(),
});
export type SelectlistQuery = z.infer<typeof SelectlistQuerySchema>;

export const SelectlistOptionSchema = z.object({
  id: z.union([z.number().int(), z.literal('null')]),
  text: z.string(),
  image: z.string().nullable(),
  tag_color: z.string().nullable(),
  disabled: z.boolean().optional(),
});
export type SelectlistOption = z.infer<typeof SelectlistOptionSchema>;

export const SelectlistResponseSchema = z.object({
  results: z.array(SelectlistOptionSchema),
  pagination: z.object({
    more: z.boolean(),
    per_page: z.number().int().positive(),
  }),
  total_count: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  page_count: z.number().int().nonnegative(),
});
export type SelectlistResponse = z.infer<typeof SelectlistResponseSchema>;

export interface StandardApiResponse<T = unknown> {
  status: 'success' | 'error';
  messages: string | Record<string, string[]>;
  payload: T | null;
}

export function createStandardApiResponseSchema<T extends z.ZodTypeAny>(payloadSchema: T) {
  return z.object({
    status: z.enum(['success', 'error']),
    messages: z.union([z.string(), z.record(z.array(z.string()))]),
    payload: payloadSchema.nullable(),
  });
}

export const FormattedDateObjectSchema = z.object({
  date: z.string().optional(),
  datetime: z.string().optional(),
  formatted: z.string(),
});
export type FormattedDateObject = z.infer<typeof FormattedDateObjectSchema>;

export const AssetBulkSelectableActionsSchema = z.object({
  edit: z.boolean(),
  maintenance: z.boolean(),
  checkout: z.boolean(),
  checkin: z.boolean(),
  audit: z.boolean(),
  delete: z.boolean(),
  labels: z.boolean(),
  restore: z.boolean(),
});
export type AssetBulkSelectableActions = z.infer<typeof AssetBulkSelectableActionsSchema>;

export const AvailableActionsSchema = z.object({
  checkout: z.boolean().optional(),
  checkin: z.boolean().optional(),
  clone: z.boolean().optional(),
  restore: z.boolean().optional(),
  update: z.boolean().optional(),
  audit: z.boolean().optional(),
  delete: z.boolean().optional(),
  view: z.boolean().optional(),
  request: z.boolean().optional(),
  cancel: z.boolean().optional(),
  bulk_selectable: AssetBulkSelectableActionsSchema.partial().optional(),
});
export type AvailableActions = z.infer<typeof AvailableActionsSchema>;

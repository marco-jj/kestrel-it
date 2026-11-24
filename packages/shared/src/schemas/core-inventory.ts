import { z } from 'zod';

export const CORE_INVENTORY_RESOURCES = [
  'companies',
  'groups',
  'users',
  'locations',
  'departments',
  'categories',
  'manufacturers',
  'suppliers',
  'statuslabels',
] as const;
export type CoreInventoryResource = (typeof CORE_INVENTORY_RESOURCES)[number];

export const InventoryIdSchema = z.coerce.number().int().positive().max(2_147_483_647);
export const InventoryBulkSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('edit'),
      ids: z.array(InventoryIdSchema).min(1).max(100),
      changes: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({ action: z.literal('delete'), ids: z.array(InventoryIdSchema).min(1).max(100) })
    .strict(),
  z
    .object({ action: z.literal('restore'), ids: z.array(InventoryIdSchema).min(1).max(100) })
    .strict(),
]);

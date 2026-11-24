import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  accessoriesCheckout,
  componentsAssets,
  consumablesUsers,
  licenseSeats,
} from '../../db/schema/index.js';
import type { InventoryDatabase } from './inventory-queries.js';

export async function hasSecondaryAssignments(
  db: InventoryDatabase,
  target: 'asset' | 'location' | 'user',
  id: number,
): Promise<boolean> {
  const accessory = and(
    eq(accessoriesCheckout.assignedType, target),
    eq(accessoriesCheckout.assignedTo, id),
  );
  const additional =
    target === 'asset'
      ? sql`or exists (select 1 from ${componentsAssets} where ${componentsAssets.assetId} = ${id})
        or exists (select 1 from ${licenseSeats} where ${licenseSeats.assetId} = ${id} and ${licenseSeats.deletedAt} is null)`
      : target === 'user'
        ? sql`or exists (select 1 from ${licenseSeats} where ${licenseSeats.assignedTo} = ${id} and ${licenseSeats.deletedAt} is null)
          or exists (select 1 from ${consumablesUsers} where ${and(
            eq(consumablesUsers.assignedTo, id),
            isNull(consumablesUsers.consumedAt),
          )})`
        : sql.empty();
  const [row] = await db.execute<{ assigned: boolean }>(sql`
    select (exists (select 1 from ${accessoriesCheckout} where ${accessory}) ${additional}) as assigned
  `);
  return row!.assigned;
}

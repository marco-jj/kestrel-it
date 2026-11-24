import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PolymorphicItemType } from '@kestrel-it/shared';
import { orderItems, orders } from '../../db/schema/index.js';
import type { InventoryTransaction } from './inventory-queries.js';

export async function recordAcquisition(
  tx: InventoryTransaction,
  data: {
    companyId: number | null;
    supplierId?: number | null;
    number: string;
    itemType: PolymorphicItemType;
    itemId: number;
    quantity: number;
    unitCost?: string | null;
    currency?: string | null;
    purchaseDate?: string | null;
    createdBy: number;
  },
) {
  const [existing] = await tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.orderNumber, data.number),
        sql`${orders.companyId} is not distinct from ${data.companyId}`,
        sql`${orders.supplierId} is not distinct from ${data.supplierId ?? null}`,
        isNull(orders.deletedAt),
      ),
    )
    .orderBy(orders.id)
    .limit(1)
    .for('update');
  const order =
    existing ??
    (
      await tx
        .insert(orders)
        .values({
          orderNumber: data.number,
          companyId: data.companyId,
          supplierId: data.supplierId,
          purchaseDate: data.purchaseDate,
          createdBy: data.createdBy,
        })
        .returning()
    )[0]!;
  const [line] = await tx
    .insert(orderItems)
    .values({
      orderId: order.id,
      itemType: data.itemType,
      itemId: data.itemId,
      quantity: data.quantity,
      unitCost: data.unitCost,
      currency: data.currency,
      purchaseDate: data.purchaseDate ?? order.purchaseDate,
      createdBy: data.createdBy,
    })
    .returning({ id: orderItems.id });
  return line!.id;
}

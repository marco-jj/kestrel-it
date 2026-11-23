import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  type AuthenticatedUserContext,
  type DatatableQuery,
  type PermissionKey,
} from '@kestrel-it/shared';
import { and, count, eq, getTableColumns, isNull, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { permitsEntity, permitsKey } from '../../common/guards/permissions.guard.js';
import { actionLogs, settings } from '../../db/schema/index.js';
import {
  datatable,
  pageOffset,
  type InventoryDatabase,
  type InventoryTransaction,
} from './inventory-queries.js';

export const currentSettings = async (db: InventoryDatabase) =>
  (await db.select().from(settings).orderBy(settings.id).limit(1))[0];

export function requireInventoryPermission(
  user: AuthenticatedUserContext,
  permission: PermissionKey,
  direct = false,
) {
  if (!(direct ? permitsKey : permitsEntity)(user, permission)) {
    throw new ForbiddenException('Insufficient permissions for this operation');
  }
}

export async function activeReference(
  db: InventoryDatabase,
  table: PgTable,
  id: number,
  scope?: SQL,
) {
  const columns = getTableColumns(table);
  const [reference] = await db
    .select({ id: columns.id! })
    .from(table)
    .where(and(eq(columns.id!, id), columns.deletedAt && isNull(columns.deletedAt), scope));
  if (!reference) throw new NotFoundException('Referenced record not found');
}

export async function inventoryPage<T extends Record<string, unknown>>(
  db: InventoryDatabase,
  table: PgTable,
  fields: T & Record<string, AnyPgColumn | SQL>,
  filter: SQL | undefined,
  orderBy: SQL[],
  query: DatatableQuery,
  url: string,
) {
  const [[total], rows] = await Promise.all([
    db.select({ value: count() }).from(table).where(filter),
    db
      .select(fields)
      .from(table)
      .where(filter)
      .orderBy(...orderBy)
      .limit(query.limit)
      .offset(pageOffset(query)),
  ]);
  return datatable(total!.value, rows, query, url);
}

export function writeInventoryLog(
  tx: InventoryTransaction,
  values: typeof actionLogs.$inferInsert,
) {
  return tx
    .insert(actionLogs)
    .values({
      actionDate: new Date(),
      actionSource: 'api',
      ...values,
    })
    .returning({ id: actionLogs.id });
}

export async function actionHistory(
  db: InventoryDatabase,
  type: string,
  id: number,
  query: DatatableQuery,
  url: string,
  user: AuthenticatedUserContext,
  scope?: SQL,
) {
  return inventoryPage(
    db,
    actionLogs,
    {
      id: actionLogs.id,
      action_type: actionLogs.actionType,
      action_date: sql<Date>`coalesce(${actionLogs.actionDate}, ${actionLogs.createdAt})`,
      target_type: actionLogs.targetType,
      target_id: permitsEntity(user, 'users.view')
        ? actionLogs.targetId
        : sql<
            number | null
          >`case when ${actionLogs.targetType} <> 'user' then ${actionLogs.targetId} end`,
      quantity: actionLogs.quantity,
      note: actionLogs.note,
      order_item_id: actionLogs.orderItemId,
      has_photo: sql<boolean>`${actionLogs.filename} is not null`,
    },
    and(
      eq(actionLogs.itemType, type),
      eq(actionLogs.itemId, id),
      isNull(actionLogs.deletedAt),
      scope,
    ),
    [
      sql`coalesce(${actionLogs.actionDate}, ${actionLogs.createdAt}) desc`,
      sql`${actionLogs.id} desc`,
    ],
    query,
    url,
  );
}

import { integer, timestamp } from 'drizzle-orm/pg-core';

/**
 * Identity primary key supporting both automatic generation and explicit ID insertion during Snipe-IT migration.
 */
export function identityId() {
  return integer('id').primaryKey().generatedByDefaultAsIdentity();
}

export function timestamps() {
  return {
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  };
}

export function timestampsNoSoftDelete() {
  return {
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  };
}

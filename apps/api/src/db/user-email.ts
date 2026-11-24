import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

export function userEmailMatches(column: AnyPgColumn, email: string) {
  return sql`lower(btrim(${column})) = lower(${email})`;
}

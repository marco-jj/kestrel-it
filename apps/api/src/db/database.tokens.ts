import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from './schema/index.js';

export const POSTGRES_CLIENT = Symbol('POSTGRES_CLIENT');
export const DRIZZLE_DB = Symbol('DRIZZLE_DB');

export type DrizzleDb = PostgresJsDatabase<typeof schema>;

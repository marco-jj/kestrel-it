import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import {
  type DatatableQuery,
  type DatatableResponse,
  type SelectlistOption,
  type SelectlistQuery,
  type SelectlistResponse,
  type StandardApiResponse,
} from '@kestrel-it/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { output, ZodType } from 'zod';
import type { DrizzleDb } from '../../db/database.module.js';

export type InventoryTransaction = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
export type InventoryDatabase = DrizzleDb | InventoryTransaction;

export async function inventoryWrite<T>(
  db: DrizzleDb,
  work: (tx: InventoryTransaction) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      // All inventory mutations share the lock for hierarchy and polymorphic integrity checks.
      await tx.execute(sql`select pg_advisory_xact_lock(64102, 2)`);
      return work(tx);
    });
  } catch (error) {
    const code =
      (error as { code?: string; cause?: { code?: string } })?.cause?.code ??
      (error as { code?: string })?.code;
    if (code === '23505' || code === '23503') {
      throw new ConflictException('An existing record conflicts with this change');
    }
    throw error;
  }
}

export function parse<T extends ZodType>(schema: T, input: unknown): output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const { fieldErrors, formErrors } = result.error.flatten();
    throw new UnprocessableEntityException({
      status: 'error',
      messages: formErrors.length ? { ...fieldErrors, form: formErrors } : fieldErrors,
      payload: null,
    });
  }
  return result.data;
}

export function success<T>(payload: T, messages = 'Saved successfully'): StandardApiResponse<T> {
  return { status: 'success', messages, payload };
}

export function datatable<T>(
  total: number,
  rows: T[],
  query: DatatableQuery,
  requestUrl: string,
): DatatableResponse<T> {
  const page = Math.floor(pageOffset(query) / query.limit) + 1;
  const pages = Math.ceil(total / query.limit);
  const link = (n: number) => {
    const url = new URL(requestUrl, 'http://localhost');
    url.searchParams.delete('offset');
    url.searchParams.set('limit', String(query.limit));
    url.searchParams.set('page', String(n));
    return url.pathname + url.search;
  };
  return {
    total,
    rows,
    current_page: page,
    per_page: query.limit,
    total_pages: pages,
    prev_page_url: page > 1 && pages > 0 ? link(page - 1) : null,
    next_page_url: page < pages ? link(page + 1) : null,
  };
}

export function pageOffset(query: DatatableQuery): number {
  return query.offset ?? ((query.page ?? 1) - 1) * query.limit;
}

export function selectlist(
  total: number,
  rows: SelectlistOption[],
  query: SelectlistQuery,
): SelectlistResponse {
  const pages = Math.ceil(total / query.limit);
  const results =
    query.page === 1 && query.includeNull
      ? [{ id: 'null' as const, text: 'No value', image: null, tag_color: null }, ...rows]
      : rows;
  return {
    results,
    pagination: { more: query.page < pages, per_page: query.limit },
    total_count: total,
    page: query.page,
    page_count: pages,
  };
}

export function contains(column: SQL | import('drizzle-orm').SQLWrapper, value: string): SQL {
  return sql`${column} ilike ${'%' + value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_') + '%'}`;
}

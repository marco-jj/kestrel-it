import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { resolveAssignedCompanyId, type AuthenticatedUserContext } from '@kestrel-it/shared';
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import { companyUser, settings, users } from '../../db/schema/index.js';
import type { InventoryDatabase } from './inventory-queries.js';

export interface FmcsScope {
  readonly enabled: boolean;
  readonly floater: boolean;
  readonly scopeLocations: boolean;
  readonly companyIds: number[];
}

@Injectable()
export class FmcsScopeService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async resolve(
    user: AuthenticatedUserContext,
    db: InventoryDatabase = this.db,
  ): Promise<FmcsScope> {
    const [row] = await db
      .select({
        enabled: settings.fullMultipleCompaniesSupport,
        floater: settings.nullCompanyIsFloater,
        scopeLocations: settings.scopeLocationsFmcs,
      })
      .from(settings)
      .orderBy(settings.id)
      .limit(1);
    return {
      enabled: row?.enabled === true && !user.isSuperUser,
      floater: row?.floater ?? false,
      scopeLocations: row?.scopeLocations ?? false,
      companyIds: user.userCompanyIds,
    };
  }

  predicate(
    scope: FmcsScope,
    resource: string,
    id: AnyPgColumn,
    companyId?: AnyPgColumn,
  ): SQL | undefined {
    if (!scope.enabled) return undefined;
    if (resource === 'locations' && !scope.scopeLocations) return undefined;
    if (resource === 'companies') {
      return scope.companyIds.length ? inArray(id, scope.companyIds) : sql`false`;
    }
    if (resource === 'users') {
      const belongs = sql`exists (select 1 from ${companyUser} where ${eq(companyUser.userId, id)}`;
      const noCompany = sql`not ${belongs})`;
      if (scope.companyIds.length === 0) return scope.floater ? undefined : noCompany;
      const shared = sql`${belongs} and ${inArray(companyUser.companyId, scope.companyIds)})`;
      return scope.floater ? or(shared, noCompany) : shared;
    }
    if (!companyId) return undefined;
    if (!scope.companyIds.length) return scope.floater ? undefined : isNull(companyId);
    const allowed = inArray(companyId, scope.companyIds);
    return scope.floater ? or(allowed, isNull(companyId)) : allowed;
  }

  selectionPredicate(
    scope: FmcsScope,
    resource: string,
    column: AnyPgColumn | undefined,
    companyId: number | undefined,
  ): SQL | undefined {
    if (
      companyId === undefined ||
      !scope.enabled ||
      (resource === 'locations' && !scope.scopeLocations)
    )
      return undefined;
    if (companyId === 0 && scope.floater) return undefined;

    if (resource === 'users') {
      const membership = and(
        eq(companyUser.userId, users.id),
        companyId === 0 ? undefined : eq(companyUser.companyId, companyId),
      );
      const unassigned = sql`not exists (select 1 from ${companyUser} where ${eq(companyUser.userId, users.id)})`;
      if (companyId === 0) return unassigned;
      const assigned = sql`exists (select 1 from ${companyUser} where ${membership})`;
      return scope.floater ? or(assigned, unassigned) : assigned;
    }

    if (!column) return undefined;
    if (companyId === 0) return isNull(column);
    const assigned = eq(column, companyId);
    return scope.floater ? or(assigned, isNull(column)) : assigned;
  }

  assign(scope: FmcsScope, value: number | null | undefined): number | null {
    try {
      if (scope.enabled && typeof value === 'number' && !scope.companyIds.includes(value)) {
        throw new Error('Company outside scope');
      }
      if (scope.enabled && scope.floater && value === null) return null;
      if (scope.enabled && !scope.floater && scope.companyIds.length > 1 && value == null) {
        throw new Error('Company selection required');
      }
      return resolveAssignedCompanyId({
        fmcsEnabled: scope.enabled,
        nullCompanyIsFloater: scope.floater,
        isSuperUser: false,
        userCompanyIds: scope.companyIds,
        submittedCompanyId: value,
      });
    } catch {
      throw new UnprocessableEntityException({
        status: 'error',
        messages: { company_id: ['The company is outside your company scope'] },
        payload: null,
      });
    }
  }

  compatible(scope: FmcsScope, companyId: number | null, targetCompanyIds: number[]): boolean {
    if (!scope.enabled) return true;
    if (companyId === null) return scope.floater || targetCompanyIds.length === 0;
    if (targetCompanyIds.length === 0) return scope.floater;
    return targetCompanyIds.includes(companyId);
  }
}

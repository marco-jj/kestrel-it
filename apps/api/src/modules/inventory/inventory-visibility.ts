import type {
  AuthenticatedUserContext,
  CheckoutTargetType,
  PermissionKey,
} from '@kestrel-it/shared';
import { and, getTableColumns, isNull, or, sql, type SQLWrapper } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { permitsEntity } from '../../common/guards/permissions.guard.js';
import {
  accessories,
  actionLogs,
  assetMaintenances,
  assets,
  companies,
  components,
  consumables,
  departments,
  licenseSeats,
  licenses,
  locations,
  models,
  suppliers,
  users,
} from '../../db/schema/index.js';
import type { FmcsScope, FmcsScopeService } from './fmcs-scope.service.js';

const activitySources: readonly [string, PgTable, string, PermissionKey][] = [
  ['asset', assets, 'hardware', 'assets.view'],
  ['model', models, 'models', 'models.view'],
  ['license', licenses, 'licenses', 'licenses.view'],
  ['accessory', accessories, 'accessories', 'accessories.view'],
  ['consumable', consumables, 'consumables', 'consumables.view'],
  ['component', components, 'components', 'components.view'],
  ['user', users, 'users', 'users.view'],
  ['company', companies, 'companies', 'companies.view'],
  ['department', departments, 'departments', 'departments.view'],
  ['location', locations, 'locations', 'locations.view'],
  ['supplier', suppliers, 'suppliers', 'suppliers.view'],
  ['maintenance', assetMaintenances, 'maintenances', 'assets.view'],
];

export function visibleActivityItems(
  fmcs: FmcsScopeService,
  scope: FmcsScope,
  options: { actor?: AuthenticatedUserContext; includeLicenseSeats?: boolean } = {},
) {
  const { actor, includeLicenseSeats } = options;
  const recordScope = (table: PgTable, name: string) => {
    const columns = getTableColumns(table);
    return fmcs.predicate(scope, name, columns.id!, columns.companyId) ?? sql`true`;
  };
  const visible = activitySources
    .filter(([, , , permission]) => !actor || permitsEntity(actor, permission))
    .map(([type, table, name]) => {
      const { id } = getTableColumns(table);
      const sourceScope = type === 'maintenance'
        ? sql`exists (select 1 from ${assets} where ${assets.id} = ${assetMaintenances.itemId}
          and ${recordScope(assets, 'hardware')})`
        : recordScope(table, name);
      return sql`(${actionLogs.itemType} = ${type} and exists (select 1 from ${table}
        where ${id} = ${actionLogs.itemId} and ${sourceScope}))`;
    });

  if (includeLicenseSeats && (!actor || permitsEntity(actor, 'licenses.view'))) {
    visible.push(sql`(${actionLogs.itemType} = 'license_seat' and exists (
      select 1 from ${licenseSeats} join ${licenses} on ${licenses.id} = ${licenseSeats.licenseId}
      where ${licenseSeats.id} = ${actionLogs.itemId} and ${recordScope(licenses, 'licenses')}
    ))`);
  }

  return or(...visible) ?? sql`false`;
}

export function scopedAssignmentTarget(
  fmcs: FmcsScopeService,
  scope: FmcsScope,
  actor: AuthenticatedUserContext,
  kind: CheckoutTargetType,
  field: SQLWrapper,
) {
  const resource = kind === 'user' ? 'users' : kind === 'asset' ? 'assets' : 'locations';
  if (!permitsEntity(actor, `${resource}.view`)) return sql<number | null>`null`;
  const table = kind === 'user' ? users : kind === 'asset' ? assets : locations;
  const allowed = assignmentTargetPredicate(fmcs, scope, resource, table, field);
  return sql<number | null>`case when exists (select 1 from ${table} where ${allowed}) then ${field} end`;
}

export function scopedAssignmentUserLabel(
  fmcs: FmcsScopeService,
  scope: FmcsScope,
  actor: AuthenticatedUserContext,
  field: SQLWrapper,
) {
  if (!permitsEntity(actor, 'users.view')) return sql<string | null>`null`;
  const allowed = assignmentTargetPredicate(fmcs, scope, 'users', users, field);
  return sql<string | null>`(select coalesce(
    nullif(btrim(${users.displayName}), ''),
    nullif(btrim(concat_ws(' ', ${users.firstName}, ${users.lastName})), ''),
    nullif(btrim(${users.email}), ''),
    ${users.username}
  ) from ${users} where ${allowed})`;
}

function assignmentTargetPredicate(
  fmcs: FmcsScopeService,
  scope: FmcsScope,
  resource: 'users' | 'assets' | 'locations',
  table: typeof users | typeof assets | typeof locations,
  field: SQLWrapper,
) {
  return and(
    sql`${table.id} = ${field}`,
    isNull(table.deletedAt),
    fmcs.predicate(scope, resource, table.id, 'companyId' in table ? table.companyId : undefined),
  );
}

import { ALL_PERMISSIONS, type PermissionKey, type PermissionMap } from './permissions.js';

/**
 * Returns true if the user is a Superuser (via user grant or non-denied group inheritance).
 */
export function isSuperUser(
  userPermissions: PermissionMap = {},
  groupPermissionsList: PermissionMap[] = [],
): boolean {
  if (userPermissions['superuser'] === 1) {
    return true;
  }
  if (userPermissions['superuser'] === -1) {
    return false;
  }
  return groupPermissionsList.some((group) => group['superuser'] === 1);
}

/**
 * Returns true if the user has Admin access (or Superuser, which supersedes Admin).
 * Note: Admin grants item permissions but remains subject to FMCS company scoping.
 */
export function isAdmin(
  userPermissions: PermissionMap = {},
  groupPermissionsList: PermissionMap[] = [],
): boolean {
  if (isSuperUser(userPermissions, groupPermissionsList)) {
    return true;
  }
  if (userPermissions['admin'] === 1) {
    return true;
  }
  if (userPermissions['admin'] === -1) {
    return false;
  }
  return groupPermissionsList.some((group) => group['admin'] === 1);
}

/**
 * Evaluates a single RBAC permission following Snipe-IT precedence:
 * Superuser > Explicit User Grant/Deny (1 / -1) > Admin (except 'superuser') > Group Grant (1).
 */
export function hasAccess(
  userPermissions: PermissionMap = {},
  groupPermissionsList: PermissionMap[] = [],
  requiredPermission: PermissionKey,
): boolean {
  if (isSuperUser(userPermissions, groupPermissionsList)) {
    return true;
  }

  if (userPermissions[requiredPermission] === 1) {
    return true;
  }
  if (userPermissions[requiredPermission] === -1) {
    return false;
  }

  if (requiredPermission !== 'superuser' && isAdmin(userPermissions, groupPermissionsList)) {
    return true;
  }

  return groupPermissionsList.some((group) => group[requiredPermission] === 1);
}

/**
 * Resolves all permission keys into a flat boolean capability map for the client or API session.
 */
export function resolveEffectivePermissions(
  userPermissions: PermissionMap = {},
  groupPermissionsList: PermissionMap[] = [],
): Record<PermissionKey, boolean> {
  const effective = {} as Record<PermissionKey, boolean>;
  for (const permission of ALL_PERMISSIONS) {
    effective[permission] = hasAccess(userPermissions, groupPermissionsList, permission);
  }
  return effective;
}

export interface FmcsAccessCheckInput {
  fmcsEnabled: boolean;
  nullCompanyIsFloater: boolean;
  scopeLocationsFmcs?: boolean;
  isSuperUser: boolean;
  /** Current actor's company IDs (already expanded with 1-level child companies). */
  userCompanyIds: number[];
  /** Target table name to handle special scoping rules (companies, locations, users). */
  targetTable?: string;
  /** Whether the target table has a company_id column (defaults to true). */
  targetHasCompanyColumn?: boolean;
  /** Target record's company_id (or company.id when targetTable === 'companies'). */
  targetCompanyId?: number | null;
  /** Target user's company IDs from company_user pivot (required when targetTable === 'users'). */
  targetUserCompanyIds?: number[];
}

/**
 * Evaluates whether the current actor can access a target record under Full Multiple Company Support (FMCS).
 */
export function canAccessCompanyRecord(input: FmcsAccessCheckInput): boolean {
  if (!input.fmcsEnabled || input.isSuperUser) {
    return true;
  }

  if (input.targetTable === 'locations' && !input.scopeLocationsFmcs) {
    return true;
  }

  if (
    input.targetHasCompanyColumn === false &&
    input.targetTable !== 'users' &&
    input.targetTable !== 'companies'
  ) {
    return true;
  }

  if (input.targetTable === 'companies') {
    return input.targetCompanyId != null && input.userCompanyIds.includes(input.targetCompanyId);
  }

  if (input.targetTable === 'users') {
    return canAccessUserCompanies(
      input.userCompanyIds,
      input.targetUserCompanyIds ?? [],
      input.nullCompanyIsFloater,
    );
  }

  // Standard companyable record (assets, licenses, accessories, consumables, components, etc.)
  if (input.userCompanyIds.length === 0) {
    return input.nullCompanyIsFloater || input.targetCompanyId == null;
  }

  if (input.targetCompanyId == null) {
    return input.nullCompanyIsFloater;
  }

  return input.userCompanyIds.includes(input.targetCompanyId);
}

function canAccessUserCompanies(
  actorCompanyIds: number[],
  targetCompanyIds: number[],
  nullCompanyIsFloater: boolean,
): boolean {
  if (actorCompanyIds.length === 0) {
    return nullCompanyIsFloater || targetCompanyIds.length === 0;
  }
  if (targetCompanyIds.length === 0) {
    return nullCompanyIsFloater;
  }
  return targetCompanyIds.some((id) => actorCompanyIds.includes(id));
}

export class FmcsCompanyAssignmentError extends Error {
  constructor(message = 'Cross-tenant company assignment is not allowed.') {
    super(message);
    this.name = 'FmcsCompanyAssignmentError';
  }
}

export interface FmcsAssignCompanyInput {
  fmcsEnabled: boolean;
  nullCompanyIsFloater: boolean;
  isSuperUser: boolean;
  userCompanyIds: number[];
  submittedCompanyId?: number | string | null;
}

/**
 * Resolves and validates the company_id to persist on create/update under FMCS.
 * Throws FmcsCompanyAssignmentError if a non-superuser attempts cross-tenant assignment.
 */
export function resolveAssignedCompanyId(input: FmcsAssignCompanyInput): number | null {
  const raw = input.submittedCompanyId;
  const normalized =
    raw === undefined || raw === null || raw === '' || Number(raw) === 0 ? null : Number(raw);

  if (normalized !== null && (!Number.isInteger(normalized) || normalized < 0)) {
    throw new FmcsCompanyAssignmentError('Invalid company_id.');
  }

  if (!input.fmcsEnabled || input.isSuperUser) {
    return normalized;
  }

  if (normalized !== null) {
    if (input.userCompanyIds.includes(normalized)) {
      return normalized;
    }
    if (input.userCompanyIds.length > 0 || !input.nullCompanyIsFloater) {
      throw new FmcsCompanyAssignmentError();
    }
  }

  return input.userCompanyIds.length === 1 ? input.userCompanyIds[0]! : null;
}

import {
  applyDecorators,
  createParamDecorator,
  SetMetadata,
  type ExecutionContext,
} from '@nestjs/common';
import type { AuthenticatedUserContext, PermissionKey } from '@kestrel-it/shared';

export const IS_PUBLIC_KEY = 'isPublic';
export const REQUIRED_PERMISSIONS_KEY = 'requiredPermissions';
export const PERMISSION_MODE_KEY = 'permissionMode';

/**
 * Marks a route or controller as publicly accessible without authentication.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Requires the authenticated user to hold all specified RBAC permissions.
 */
export const RequirePermission = (...permissions: PermissionKey[]) =>
  applyDecorators(
    SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions),
    SetMetadata(PERMISSION_MODE_KEY, 'entity'),
  );

export const RequireKeyPermission = (...permissions: PermissionKey[]) =>
  applyDecorators(
    SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions),
    SetMetadata(PERMISSION_MODE_KEY, 'key'),
  );

/**
 * Extracts the resolved AuthenticatedUserContext attached by JwtOrPatAuthGuard.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUserContext => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUserContext }>();
    return request.user!;
  },
);

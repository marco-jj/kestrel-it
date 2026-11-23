import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedUserContext, PermissionKey } from '@kestrel-it/shared';
import { PERMISSION_MODE_KEY, REQUIRED_PERMISSIONS_KEY } from '../decorators/auth.decorators.js';
import type { RequestWithUser } from './jwt-or-pat-auth.guard.js';

export function permitsKey(user: AuthenticatedUserContext, permission: PermissionKey): boolean {
  return user.isSuperUser || user.keyPermissions?.[permission] === true;
}

export function permitsEntity(user: AuthenticatedUserContext, permission: PermissionKey): boolean {
  return user.isSuperUser || user.isAdmin || permitsKey(user, permission);
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<PermissionKey[]>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    const isKey = this.reflector.getAllAndOverride<string>(PERMISSION_MODE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) === 'key';
    const allowed = requiredPermissions.every((permission) =>
      isKey ? permitsKey(user, permission) : permitsEntity(user, permission),
    );

    if (!allowed) {
      throw new ForbiddenException('Insufficient permissions for this operation');
    }

    return true;
  }
}

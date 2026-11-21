import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionKey } from '@kestrel-it/shared';
import { REQUIRED_PERMISSIONS_KEY } from '../decorators/auth.decorators.js';
import type { RequestWithUser } from './jwt-or-pat-auth.guard.js';

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

    const allowed = requiredPermissions.every(
      (permission) => user.effectivePermissions[permission] === true,
    );

    if (!allowed) {
      throw new ForbiddenException('Insufficient permissions for this operation');
    }

    return true;
  }
}

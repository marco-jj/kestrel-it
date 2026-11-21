import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedUserContext } from '@kestrel-it/shared';
import { AuthService } from '../../modules/auth/auth.service.js';
import { PatService } from '../../modules/auth/pat.service.js';
import { JwtService, type AccessTokenPayload } from '../crypto/jwt.util.js';
import { IS_PUBLIC_KEY } from '../decorators/auth.decorators.js';

export const ACCESS_TOKEN_COOKIE = 'kestrel_access_token';
export const REFRESH_TOKEN_COOKIE = 'kestrel_refresh_token';
export const OIDC_STATE_COOKIE = 'kestrel_oidc_state';

export interface HttpCookieRequest {
  headers: {
    authorization?: string;
    'user-agent'?: string;
    [key: string]: string | string[] | undefined;
  };
  cookies?: Record<string, string | undefined>;
  ip?: string;
}

export type RequestWithUser = HttpCookieRequest & {
  user?: AuthenticatedUserContext;
};

@Injectable()
export class JwtOrPatAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(PatService) private readonly patService: PatService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    if (token.startsWith('kst_')) {
      request.user = await this.patService.authenticatePat(token);
      return true;
    }

    const payload = await this.jwtService.verifyToken<AccessTokenPayload>(token, 'access');
    const userId = Number(payload.sub);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new UnauthorizedException('Invalid subject in access token');
    }

    const userContext = await this.authService.loadUserContext(
      userId,
      Boolean(payload.twoFactorVerified),
      'jwt',
    );

    const global2faRequired = await this.authService.isGlobalTwoFactorRequired();
    if ((global2faRequired || userContext.twoFactorEnrolled) && !userContext.twoFactorVerified) {
      throw new UnauthorizedException('Two-factor authentication verification required');
    }

    request.user = userContext;
    return true;
  }

  private extractToken(request: HttpCookieRequest): string | null {
    const authHeader = request.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const bearer = authHeader.slice(7).trim();
      if (bearer) {
        return bearer;
      }
    }

    const cookieToken = request.cookies?.[ACCESS_TOKEN_COOKIE];
    if (typeof cookieToken === 'string' && cookieToken.trim().length > 0) {
      return cookieToken.trim();
    }

    return null;
  }
}

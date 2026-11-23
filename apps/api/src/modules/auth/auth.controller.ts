import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  BetterAuthSessionExchangeRequestSchema,
  LoginRequestSchema,
  RefreshTokenRequestSchema,
  TwoFactorVerifyRequestSchema,
  type AuthenticatedUserContext,
  type AuthProvidersStatusResponse,
  type LoginResponse,
  type StandardApiResponse,
  type TwoFactorEnrollResponse,
} from '@kestrel-it/shared';
import { z } from 'zod';
import {
  JwtService,
  type AccessTokenPayload,
  type OidcStatePayload,
  type TwoFactorChallengePayload,
} from '../../common/crypto/jwt.util.js';
import { CurrentUser, Public } from '../../common/decorators/auth.decorators.js';
import {
  ACCESS_TOKEN_COOKIE,
  OIDC_STATE_COOKIE,
  REFRESH_TOKEN_COOKIE,
  type HttpCookieRequest,
} from '../../common/guards/jwt-or-pat-auth.guard.js';
import { AuthService, sanitizeSsoRedirectPath } from './auth.service.js';
import { BetterAuthService } from './better-auth.service.js';

interface HttpCookieReply {
  setCookie(name: string, value: string, options: Record<string, unknown>): unknown;
  clearCookie(name: string, options: Record<string, unknown>): unknown;
  redirect(url: string, code?: number): unknown;
  send(payload: unknown): unknown;
}

const SSO_CHALLENGE_COOKIE = 'kestrel_sso_challenge';

const TwoFactorEnrollRequestSchema = z.object({
  challengeToken: z.string().min(1).optional(),
});

@ApiTags('Auth')
@Controller()
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(BetterAuthService) private readonly betterAuthService: BetterAuthService,
    @Inject(JwtService) private readonly jwtService: JwtService,
  ) {}

  @Public()
  @Get('auth/providers')
  @ApiOperation({ summary: 'List enabled authentication providers (Local, OIDC, OAuth 2.0/2.1, Better Auth)' })
  async getProviders(): Promise<AuthProvidersStatusResponse> {
    return this.authService.getAuthProvidersStatus();
  }

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Authenticate with local username & password' })
  async login(
    @Body() body: unknown,
    @Req() request: HttpCookieRequest,
    @Res({ passthrough: true }) reply: HttpCookieReply,
  ): Promise<LoginResponse> {
    const parsed = LoginRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        status: 'error',
        messages: parsed.error.flatten().fieldErrors,
        payload: null,
      });
    }

    const result = await this.authService.loginLocal(parsed.data, {
      remoteIp: request.ip,
      userAgent: request.headers['user-agent'],
    });

    if (result.status === 'authenticated') {
      this.setSessionCookies(reply, result.accessToken, result.refreshToken);
    }

    return result;
  }

  @Public()
  @Post('auth/refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Refresh access token using a refresh token' })
  async refresh(
    @Body() body: unknown,
    @Req() request: HttpCookieRequest,
    @Res({ passthrough: true }) reply: HttpCookieReply,
  ): Promise<LoginResponse> {
    const parsed = RefreshTokenRequestSchema.safeParse(body ?? {});
    const token =
      (parsed.success ? parsed.data.refreshToken : undefined) ??
      request.cookies?.[REFRESH_TOKEN_COOKIE];

    if (!token) {
      throw new UnauthorizedException('Refresh token required');
    }

    const result = await this.authService.refreshTokens(token);
    if (result.status === 'authenticated') {
      this.setSessionCookies(reply, result.accessToken, result.refreshToken);
    }
    return result;
  }

  @Public()
  @Post('auth/2fa/enroll')
  @HttpCode(200)
  @ApiOperation({ summary: 'Generate TOTP secret & otpauth URI for 2FA enrollment' })
  async enrollTwoFactor(
    @Body() body: unknown,
    @Req() request: HttpCookieRequest,
  ): Promise<TwoFactorEnrollResponse> {
    const parsed = TwoFactorEnrollRequestSchema.safeParse(body ?? {});
    const challengeToken = parsed.success ? parsed.data.challengeToken : undefined;
    const userId = await this.resolveUserIdFromChallengeOrAccess(challengeToken, request);
    return this.authService.enrollTwoFactor(userId);
  }

  @Public()
  @Post('auth/2fa/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify 6-digit TOTP code and complete authentication' })
  async verifyTwoFactor(
    @Body() body: unknown,
    @Req() request: HttpCookieRequest,
    @Res({ passthrough: true }) reply: HttpCookieReply,
  ): Promise<LoginResponse> {
    const parsed = TwoFactorVerifyRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        status: 'error',
        messages: parsed.error.flatten().fieldErrors,
        payload: null,
      });
    }

    const userId = await this.resolveUserIdFromChallengeOrAccess(
      parsed.data.challengeToken,
      request,
    );
    const result = await this.authService.verifyTwoFactor(userId, parsed.data.code);

    if (result.status === 'authenticated') {
      reply.clearCookie(SSO_CHALLENGE_COOKIE, { path: '/' });
      this.setSessionCookies(reply, result.accessToken, result.refreshToken);
    }

    return result;
  }

  @Public()
  @Get('auth/oidc/login')
  @ApiOperation({ summary: 'Initiate OIDC Authorization Code + PKCE flow' })
  async oidcLogin(
    @Query('redirect') redirect: string | undefined,
    @Res() reply: HttpCookieReply,
  ): Promise<void> {
    const { redirectUrl, stateCookieToken } =
      await this.authService.buildOidcAuthorizationRedirect(redirect);
    const isProd = process.env['NODE_ENV'] === 'production';

    reply.clearCookie(SSO_CHALLENGE_COOKIE, { path: '/' });
    reply.setCookie(OIDC_STATE_COOKIE, stateCookieToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      path: '/',
      maxAge: 600,
    });
    reply.redirect(redirectUrl, 302);
  }

  @Public()
  @Get('auth/oidc/callback')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Handle OIDC callback, verify ID Token, and JIT provision user' })
  async oidcCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() request: HttpCookieRequest,
    @Res() reply: HttpCookieReply,
  ): Promise<void> {
    const stateCookieToken = request.cookies?.[OIDC_STATE_COOKIE];
    if (!code || !state || !stateCookieToken) {
      throw new BadRequestException('Missing OIDC callback code, state, or state cookie');
    }

    const result = await this.authService.handleOidcCallback({
      code,
      state,
      stateCookieToken,
      remoteIp: request.ip,
      userAgent: request.headers['user-agent'],
    });

    reply.clearCookie(OIDC_STATE_COOKIE, { path: '/' });
    if (result.status === 'authenticated') {
      this.setSessionCookies(reply, result.accessToken, result.refreshToken);
    }

    if (typeof request.headers.accept !== 'string' || !request.headers.accept.includes('text/html')) {
      reply.send(result);
      return;
    }

    const verifiedState = await this.jwtService.verifyToken<OidcStatePayload>(
      stateCookieToken,
      'oidc_state',
    );
    const destination = sanitizeSsoRedirectPath(verifiedState.redirect);

    if (result.status === 'authenticated') {
      reply.redirect(destination, 303);
    } else {
      reply.setCookie(SSO_CHALLENGE_COOKIE, result.challengeToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env['NODE_ENV'] === 'production',
        path: '/',
        maxAge: 300,
      });
      const challengeUrl =
        destination !== '/dashboard' && destination !== '/'
          ? `/login?sso=challenge&redirect=${encodeURIComponent(destination)}`
          : '/login?sso=challenge';
      reply.redirect(challengeUrl, 303);
    }
  }

  @Public()
  @Get('auth/sso/challenge')
  @Header('Cache-Control', 'no-store')
  async getSsoChallenge(@Req() request: HttpCookieRequest): Promise<LoginResponse> {
    const challengeToken = request.cookies?.[SSO_CHALLENGE_COOKIE];
    if (!challengeToken) throw new UnauthorizedException('SSO challenge required');

    const payload = await this.jwtService.verifyToken<TwoFactorChallengePayload>(
      challengeToken, '2fa_challenge',
    );
    return {
      status: '2fa_required',
      requiresTwoFactor: true,
      requiresEnrollment: payload.requiresEnrollment,
      challengeToken,
    };
  }

  @Public()
  @Get('auth/oauth/login')
  @ApiOperation({ summary: 'Initiate OAuth 2.0 / OAuth 2.1 Authorization Code + PKCE (S256) flow' })
  async oauthLogin(
    @Query('redirect') redirect: string | undefined,
    @Res() reply: HttpCookieReply,
  ): Promise<void> {
    return this.oidcLogin(redirect, reply);
  }

  @Public()
  @Get('auth/oauth/callback')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Handle OAuth 2.0 / OAuth 2.1 callback and JIT provision user' })
  async oauthCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() request: HttpCookieRequest,
    @Res() reply: HttpCookieReply,
  ): Promise<void> {
    return this.oidcCallback(code, state, request, reply);
  }

  @Public()
  @Post('auth/better-auth/exchange')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Exchange a signed embedded or federated Better Auth session into a Kestrel-IT RBAC session',
  })
  async exchangeBetterAuthSession(
    @Body() body: unknown,
    @Req() request: HttpCookieRequest,
    @Res({ passthrough: true }) reply: HttpCookieReply,
  ): Promise<LoginResponse> {
    const parsed = BetterAuthSessionExchangeRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        status: 'error',
        messages: parsed.error.flatten().fieldErrors,
        payload: null,
      });
    }

    const result = await this.betterAuthService.exchangeSession(parsed.data, {
      remoteIp: request.ip,
      userAgent: request.headers['user-agent'],
    });

    if (result.status === 'authenticated') {
      this.setSessionCookies(reply, result.accessToken, result.refreshToken);
    }
    return result;
  }

  @Public()
  @Post(['logout', 'auth/logout'])
  @HttpCode(200)
  @ApiOperation({ summary: 'Clear session cookies and revoke the presented refresh token' })
  async logout(
    @Body() body: unknown,
    @Req() request: HttpCookieRequest,
    @Res({ passthrough: true }) reply: HttpCookieReply,
  ): Promise<StandardApiResponse<null>> {
    const parsed = RefreshTokenRequestSchema.safeParse(body ?? {});
    const refreshToken =
      (parsed.success ? parsed.data.refreshToken : undefined) ??
      request.cookies?.[REFRESH_TOKEN_COOKIE];
    await this.authService.revokeRefreshToken(refreshToken);

    reply.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
    reply.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/' });
    reply.clearCookie(SSO_CHALLENGE_COOKIE, { path: '/' });
    return {
      status: 'success',
      messages: 'Logged out successfully.',
      payload: null,
    };
  }

  @ApiBearerAuth()
  @Get(['users/me', 'auth/me'])
  @ApiOperation({ summary: 'Return authenticated user context, companies, and RBAC permissions' })
  getMe(@CurrentUser() user: AuthenticatedUserContext): AuthenticatedUserContext {
    return user;
  }

  private async resolveUserIdFromChallengeOrAccess(
    challengeToken: string | undefined,
    request: HttpCookieRequest,
  ): Promise<number> {
    if (challengeToken) {
      const payload = await this.jwtService.verifyToken<TwoFactorChallengePayload>(
        challengeToken,
        '2fa_challenge',
      );
      const userId = Number(payload.sub);
      if (!Number.isInteger(userId) || userId <= 0) {
        throw new UnauthorizedException('Invalid 2FA challenge subject');
      }
      return userId;
    }

    const authHeader = request.headers.authorization;
    const bearer =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : null;
    const accessToken = bearer || request.cookies?.[ACCESS_TOKEN_COOKIE];
    if (!accessToken) {
      throw new UnauthorizedException('Challenge token or active session required');
    }

    const payload = await this.jwtService.verifyToken<AccessTokenPayload>(accessToken, 'access');
    const userId = Number(payload.sub);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new UnauthorizedException('Invalid access token subject');
    }
    return userId;
  }

  private setSessionCookies(
    reply: HttpCookieReply,
    accessToken: string,
    refreshToken: string,
  ): void {
    const isProd = process.env['NODE_ENV'] === 'production';
    reply.setCookie(ACCESS_TOKEN_COOKIE, accessToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      path: '/',
    });
    reply.setCookie(REFRESH_TOKEN_COOKIE, refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      path: '/',
    });
  }
}

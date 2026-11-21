import {
  BadRequestException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BetterAuthUserPayloadSchema,
  type BetterAuthMode,
  type BetterAuthSessionExchangeRequest,
  type BetterAuthUserPayload,
  type LoginResponse,
} from '@kestrel-it/shared';
import { eq } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EnvConfig } from '../../config/env.schema.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import { loginAttempts, personalAccessTokens, users } from '../../db/schema/index.js';
import { AuthService } from './auth.service.js';
import { OidcUserProvisioningService } from './oidc-provisioning.service.js';

export interface BetterAuthStatus {
  enabled: boolean;
  mode: BetterAuthMode;
  passkeyEnabled: boolean;
  providers: string[];
}

@Injectable()
export class BetterAuthService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(ConfigService) private readonly config: ConfigService<EnvConfig, true>,
    @Inject(OidcUserProvisioningService)
    private readonly oidcProvisioning: OidcUserProvisioningService,
    @Inject(AuthService) private readonly authService: AuthService,
  ) {}

  getStatus(): BetterAuthStatus {
    const enabled = this.config.get('BETTER_AUTH_ENABLED', { infer: true });
    const configuredMode = this.config.get('BETTER_AUTH_MODE', { infer: true });
    const mode: BetterAuthMode = enabled
      ? configuredMode === 'disabled'
        ? 'embedded'
        : configuredMode
      : 'disabled';
    const passkeyEnabled =
      enabled && this.config.get('BETTER_AUTH_PASSKEY_ENABLED', { infer: true });
    const providers = enabled
      ? this.config
          .get('BETTER_AUTH_PROVIDERS', { infer: true })
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
      : [];

    return {
      enabled,
      mode,
      passkeyEnabled,
      providers,
    };
  }

  /**
   * Produces the structured configuration object for embedding `better-auth` with
   * Drizzle ORM (`provider: 'pg'`), OAuth 2.1 PKCE plugins, Passkeys, and Kestrel-IT's
   * JIT provisioning database hooks.
   */
  buildBetterAuthDrizzleConfig() {
    const status = this.getStatus();
    const apiPrefix = this.config.get('API_PREFIX', { infer: true }).replace(/^\/+|\/+$/g, '');
    const appUrl = this.config.get('APP_URL', { infer: true }).replace(/\/+$/, '');
    const configuredUrl = this.config.get('BETTER_AUTH_URL', { infer: true });

    return {
      database: {
        adapter: 'drizzle' as const,
        provider: 'pg' as const,
        db: this.db,
        schema: {
          user: users,
          apikey: personalAccessTokens,
        },
      },
      basePath: `/${apiPrefix}/auth/better-auth`,
      baseURL: configuredUrl || appUrl,
      secret: this.resolveBridgeSecret(),
      plugins: {
        genericOAuth: {
          enabled: status.enabled,
          pkce: true,
          codeChallengeMethod: 'S256' as const,
          providers: status.providers,
        },
        twoFactor: { enabled: true },
        passkey: { enabled: status.passkeyEnabled },
        bearer: { enabled: true },
      },
      databaseHooks: this.createDatabaseHooks(),
    };
  }

  /**
   * BetterAuthProvisioningBridge hooks that route user/session creation events
   * into Kestrel-IT's JIT provisioning, group sync, FMCS scoping, and 87-permission RBAC engine.
   */
  createDatabaseHooks() {
    return {
      user: {
        create: {
          after: async (baUser: BetterAuthUserPayload & { providerId?: string }) => {
            const claims = this.toProvisioningClaims(baUser, baUser.providerId ?? 'better-auth');
            return this.oidcProvisioning.resolveOrProvisionUser(claims);
          },
        },
      },
      session: {
        create: {
          after: async (
            _session: { userId: string; token?: string },
            context?: { user?: BetterAuthUserPayload; providerId?: string },
          ) => {
            if (!context?.user) {
              return null;
            }
            const claims = this.toProvisioningClaims(
              context.user,
              context.providerId ?? 'better-auth',
            );
            return this.oidcProvisioning.resolveOrProvisionUser(claims);
          },
        },
      },
    };
  }

  signBetterAuthBridgePayload(payload: {
    providerId: string;
    user: BetterAuthUserPayload;
  }): string {
    const canonical = this.buildCanonicalBridgeMessage(payload.providerId, payload.user);
    return createHmac('sha256', this.resolveBridgeSecret()).update(canonical).digest('hex');
  }

  verifyBetterAuthBridgeSignature(
    payload: { providerId: string; user: BetterAuthUserPayload },
    signature: string,
  ): boolean {
    const expectedHex = this.signBetterAuthBridgePayload(payload);
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    const providedBuf = Buffer.from(signature.trim(), 'hex');
    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }
    return timingSafeEqual(expectedBuf, providedBuf);
  }

  async exchangeSession(
    dto: BetterAuthSessionExchangeRequest,
    meta: { remoteIp?: string; userAgent?: string } = {},
  ): Promise<LoginResponse> {
    const status = this.getStatus();
    if (!status.enabled) {
      throw new BadRequestException('Better Auth integration is not enabled');
    }

    let resolvedBaUser: BetterAuthUserPayload;

    if (dto.user) {
      if (!dto.signature) {
        throw new UnauthorizedException('Better Auth bridge signature is required');
      }
      const validSig = this.verifyBetterAuthBridgeSignature(
        { providerId: dto.providerId, user: dto.user },
        dto.signature,
      );
      if (!validSig) {
        throw new UnauthorizedException('Invalid Better Auth bridge signature');
      }
      resolvedBaUser = dto.user;
    } else if (dto.sessionToken) {
      resolvedBaUser = await this.fetchFederatedSessionUser(dto.sessionToken);
    } else {
      throw new BadRequestException(
        'Either a signed Better Auth user payload or a sessionToken must be provided',
      );
    }

    const claims = this.toProvisioningClaims(
      resolvedBaUser,
      dto.providerId,
      dto.accountId,
    );
    const provisionedUser = await this.oidcProvisioning.resolveOrProvisionUser(claims);

    await this.db.insert(loginAttempts).values({
      username: provisionedUser.username,
      remoteIp: meta.remoteIp ?? null,
      userAgent: meta.userAgent ?? null,
      successful: true,
      loginVia: 'better-auth',
    });

    if (typeof this.authService.completeUserAuthentication === 'function') {
      return this.authService.completeUserAuthentication(provisionedUser, {
        federatedMfaSatisfied: AuthService.hasFederatedMfaClaim(claims),
      });
    }

    await this.db
      .update(users)
      .set({ lastLogin: new Date(), updatedAt: new Date() })
      .where(eq(users.id, provisionedUser.id));

    return this.authService.issueSessionForUser(provisionedUser.id, true);
  }

  toProvisioningClaims(
    baUser: BetterAuthUserPayload,
    providerId: string,
    accountId?: string,
  ): Record<string, unknown> {
    const issuer = providerId.startsWith('better-auth:')
      ? providerId
      : `better-auth:${providerId}`;

    const claims: Record<string, unknown> = {
      iss: issuer,
      sub: accountId || baUser.id,
      email: baUser.email,
      email_verified: baUser.emailVerified,
      preferred_username: baUser.username || baUser.email,
      two_factor_verified:
        baUser.twoFactorVerified === true ||
        providerId === 'passkey' ||
        providerId === 'better-auth:passkey',
    };

    if (baUser.name) claims['name'] = baUser.name;
    if (baUser.firstName) claims['given_name'] = baUser.firstName;
    if (baUser.lastName) claims['family_name'] = baUser.lastName;
    if (baUser.groups) claims['groups'] = baUser.groups;
    if (baUser.company) claims['company'] = baUser.company;
    if (baUser.amr) claims['amr'] = baUser.amr;

    return claims;
  }

  private async fetchFederatedSessionUser(sessionToken: string): Promise<BetterAuthUserPayload> {
    const baseUrl = this.config.get('BETTER_AUTH_URL', { infer: true }).replace(/\/+$/, '');
    if (!baseUrl) {
      throw new BadRequestException(
        'BETTER_AUTH_URL must be configured for federated session verification',
      );
    }

    const res = await fetch(`${baseUrl}/api/auth/get-session`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${sessionToken}`,
        accept: 'application/json',
      },
    });

    if (!res.ok) {
      throw new UnauthorizedException('Failed to verify session with federated Better Auth server');
    }

    const body = (await res.json()) as { user?: unknown };
    const parsed = BetterAuthUserPayloadSchema.safeParse(body?.user);
    if (!parsed.success) {
      throw new UnauthorizedException('Federated Better Auth session did not contain a valid user');
    }

    return parsed.data;
  }

  private resolveBridgeSecret(): string {
    return (
      this.config.get('BETTER_AUTH_SECRET', { infer: true }) ||
      this.config.get('JWT_SECRET', { infer: true })
    );
  }

  private buildCanonicalBridgeMessage(providerId: string, user: BetterAuthUserPayload): string {
    return JSON.stringify([
      providerId,
      user.id,
      user.email,
      user.emailVerified,
      user.username ?? null,
      user.name ?? null,
      user.firstName ?? null,
      user.lastName ?? null,
      user.groups ?? null,
      user.company ?? null,
      user.twoFactorVerified ?? null,
      user.amr ?? null,
    ]);
  }
}

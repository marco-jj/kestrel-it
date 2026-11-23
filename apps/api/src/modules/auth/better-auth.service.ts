import {
  BadRequestException,
  Inject,
  Injectable,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BetterAuthUserPayloadSchema,
  type BetterAuthMode,
  type BetterAuthSessionExchangeRequest,
  type BetterAuthUserPayload,
  type LoginResponse,
} from '@kestrel-it/shared';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { trimSlashes, trimTrailingCharacter } from '../../common/string-utils.js';
import type { EnvConfig } from '../../config/env.schema.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import { authConsumedTokens, loginAttempts, personalAccessTokens, users } from '../../db/schema/index.js';
import { AuthService } from './auth.service.js';
import { OidcUserProvisioningService } from './oidc-provisioning.service.js';

export interface BetterAuthStatus {
  enabled: boolean;
  mode: BetterAuthMode;
  passkeyEnabled: boolean;
  providers: string[];
}

const BRIDGE_ASSERTION_TTL_SECONDS = 120;

interface SignedBridgePayload {
  providerId: string;
  accountId?: string;
  user: BetterAuthUserPayload;
  issuedAt: number;
  nonce: string;
}

const FederatedSessionSchema = z.object({
  user: BetterAuthUserPayloadSchema,
  session: z.object({
    userId: z.string(),
    expiresAt: z.string().datetime({ offset: true }),
    twoFactorVerified: z.boolean().optional(),
    amr: z.array(z.string()).optional(),
  }),
});

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
    const enabledMode = configuredMode === 'disabled' ? 'embedded' : configuredMode;
    const mode: BetterAuthMode = enabled ? enabledMode : 'disabled';
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
    const apiPrefix = trimSlashes(this.config.get('API_PREFIX', { infer: true }));
    const appUrl = trimTrailingCharacter(this.config.get('APP_URL', { infer: true }), '/');
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
      secret: this.config.get('BETTER_AUTH_SECRET', { infer: true }),
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

  signBetterAuthBridgePayload(payload: SignedBridgePayload): string {
    const secret = this.config.get('BETTER_AUTH_SECRET', { infer: true });
    if (secret.length < 32) {
      throw new ServiceUnavailableException('A dedicated Better Auth bridge signing key is required');
    }
    return createHmac('sha256', secret)
      .update(this.buildCanonicalBridgeMessage(payload))
      .digest('hex');
  }

  verifyBetterAuthBridgeSignature(payload: SignedBridgePayload, signature: string): boolean {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const expected = Buffer.from(this.signBetterAuthBridgePayload(payload), 'hex');
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  }

  async exchangeSession(
    dto: BetterAuthSessionExchangeRequest,
    meta: { remoteIp?: string; userAgent?: string } = {},
  ): Promise<LoginResponse> {
    const status = this.getStatus();
    if (!status.enabled) {
      throw new BadRequestException('Better Auth integration is not enabled');
    }

    let claims: Record<string, unknown>;

    if (dto.user && !dto.sessionToken) {
      claims = await this.verifySignedExchange(dto);
    } else if (dto.sessionToken && !dto.user) {
      claims = await this.fetchFederatedSessionClaims(dto.sessionToken);
    } else {
      throw new BadRequestException('Provide exactly one Better Auth credential');
    }

    const provisionedUser = await this.oidcProvisioning.resolveOrProvisionUser(claims);

    await this.db.insert(loginAttempts).values({
      username: provisionedUser.username,
      remoteIp: meta.remoteIp ?? null,
      userAgent: meta.userAgent ?? null,
      successful: true,
      loginVia: 'better-auth',
    });

    return this.authService.completeUserAuthentication(provisionedUser, {
      federatedMfaSatisfied: AuthService.hasFederatedMfaClaim(claims),
    });
  }

  private async verifySignedExchange(dto: BetterAuthSessionExchangeRequest) {
    const { user, providerId, accountId, issuedAt, nonce, signature } = dto;
    const now = Math.floor(Date.now() / 1000);
    if (!user || !signature || !nonce || !issuedAt || issuedAt > now ||
        issuedAt + BRIDGE_ASSERTION_TTL_SECONDS <= now ||
        !this.verifyBetterAuthBridgeSignature({ user, providerId, accountId, issuedAt, nonce }, signature)) {
      throw new UnauthorizedException('Invalid or expired Better Auth bridge assertion');
    }

    const [claimed] = await this.db
      .insert(authConsumedTokens)
      .values({
        digest: `better_auth_nonce:${createHash('sha256').update(nonce).digest('hex')}`,
        expiresAt: new Date((issuedAt + BRIDGE_ASSERTION_TTL_SECONDS) * 1000),
      })
      .onConflictDoNothing()
      .returning({ digest: authConsumedTokens.digest });

    if (!claimed) throw new UnauthorizedException('Better Auth bridge assertion has already been used');
    return this.toProvisioningClaims(user, providerId, accountId);
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
      two_factor_verified: baUser.twoFactorVerified === true,
    };

    if (baUser.name) claims['name'] = baUser.name;
    if (baUser.firstName) claims['given_name'] = baUser.firstName;
    if (baUser.lastName) claims['family_name'] = baUser.lastName;
    if (baUser.groups) claims['groups'] = baUser.groups;
    if (baUser.company) claims['company'] = baUser.company;
    if (baUser.amr) claims['amr'] = baUser.amr;

    return claims;
  }

  private async fetchFederatedSessionClaims(sessionToken: string): Promise<Record<string, unknown>> {
    const baseUrl = trimTrailingCharacter(this.config.get('BETTER_AUTH_URL', { infer: true }), '/');
    if (!baseUrl) {
      throw new BadRequestException(
        'BETTER_AUTH_URL must be configured for federated session verification',
      );
    }

    const res = await fetch(`${baseUrl}/api/auth/get-session`, {
      method: 'GET',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${sessionToken}`,
        accept: 'application/json',
      },
    });

    if (!res.ok) {
      throw new UnauthorizedException('Failed to verify session with federated Better Auth server');
    }

    const parsed = FederatedSessionSchema.safeParse(await res.json());
    if (!parsed.success || parsed.data.user.id !== parsed.data.session.userId ||
        Date.parse(parsed.data.session.expiresAt) <= Date.now()) {
      throw new UnauthorizedException('Federated Better Auth session is invalid or expired');
    }

    const { user, session } = parsed.data;
    const issuer = `federated:${createHash('sha256').update(new URL(baseUrl).href).digest('hex')}`;
    return this.toProvisioningClaims({
      ...user,
      twoFactorVerified: session.twoFactorVerified,
      amr: session.amr,
    }, issuer);
  }

  private buildCanonicalBridgeMessage(payload: SignedBridgePayload): string {
    const { providerId, accountId, user, issuedAt, nonce } = payload;
    return JSON.stringify([
      'kestrel-better-auth-v2',
      providerId,
      accountId ?? null,
      issuedAt,
      nonce,
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

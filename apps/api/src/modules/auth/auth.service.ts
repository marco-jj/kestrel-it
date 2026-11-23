import {
  BadRequestException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  hasAccess,
  isAdmin,
  isSuperUser,
  ALL_PERMISSIONS,
  hasKeyAccess,
  resolveEffectivePermissions,
  TWO_FACTOR_POLICY,
  type AuthenticatedUserContext,
  type AuthProvidersStatusResponse,
  type BetterAuthMode,
  type LoginRequest,
  type LoginResponse,
  type OAuthProtocol,
  type PermissionMap,
  type TwoFactorEnrollResponse,
} from '@kestrel-it/shared';
import { and, eq, inArray, isNull, lte } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { trimSlashes, trimTrailingCharacter } from '../../common/string-utils.js';
import type { EnvConfig } from '../../config/env.schema.js';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import {
  JwtService,
  type OidcStatePayload,
  type RefreshTokenPayload,
} from '../../common/crypto/jwt.util.js';
import {
  buildOtpAuthUri,
  generateBase32Secret,
  verifyTotpCode,
} from '../../common/crypto/totp.util.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import {
  authConsumedTokens,
  companies,
  companyUser,
  groups,
  loginAttempts,
  settings,
  users,
  usersGroups,
} from '../../db/schema/index.js';
import {
  computeS256CodeChallenge,
  normalizeOAuthUserInfoToClaims,
  validateOAuth21AuthorizationRequest,
} from './oauth21.util.js';
import { OidcUserProvisioningService } from './oidc-provisioning.service.js';

interface OidcDiscoveryDoc {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri?: string;
  userinfo_endpoint?: string;
}

// Leave room in the 4 KiB cookie for JWT encoding, PKCE state, and cookie attributes.
const MAX_SSO_REDIRECT_BYTES = 2048;

export function sanitizeSsoRedirectPath(target: string | null | undefined): string {
  if (!target) {
    return '/dashboard';
  }
  const trimmed = target.trim();
  if (
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    trimmed.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(trimmed)
  ) {
    return '/dashboard';
  }
  try {
    const parsed = new URL(trimmed, 'http://kestrel.local');
    if (parsed.origin !== 'http://kestrel.local') {
      return '/dashboard';
    }
    if (
      parsed.pathname === '/login' ||
      parsed.pathname.startsWith('/login/') ||
      parsed.pathname === '/setup' ||
      parsed.pathname.startsWith('/setup/')
    ) {
      return '/dashboard';
    }
    const destination = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return Buffer.byteLength(destination) <= MAX_SSO_REDIRECT_BYTES
      ? destination
      : '/dashboard';
  } catch {
    return '/dashboard';
  }
}

@Injectable()
export class AuthService {
  private static readonly FEDERATED_MFA_AMR_VALUES = new Set([
    'mfa',
    'otp',
    'totp',
    'hwk',
    'swk',
    'fido',
    'passkey',
    'webauthn',
  ]);

  static hasFederatedMfaClaim(claims: Record<string, unknown>): boolean {
    if (claims['mfa_verified'] === true || claims['two_factor_verified'] === true) {
      return true;
    }

    const amr = claims['amr'];
    const amrValues = Array.isArray(amr) ? amr : [amr];
    return amrValues.some(
      (value) =>
        typeof value === 'string' &&
        AuthService.FEDERATED_MFA_AMR_VALUES.has(value.trim().toLowerCase()),
    );
  }

  private readonly oidcDiscoveryCache = new Map<
    string,
    { expiresAt: number; doc: OidcDiscoveryDoc }
  >();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(ConfigService) private readonly config: ConfigService<EnvConfig, true>,
    @Inject(CryptoService) private readonly cryptoService: CryptoService,
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(OidcUserProvisioningService)
    private readonly oidcProvisioning: OidcUserProvisioningService,
  ) {}

  async loginLocal(
    dto: LoginRequest,
    meta: { remoteIp?: string; userAgent?: string } = {},
  ): Promise<LoginResponse> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.username, dto.username), isNull(users.deletedAt)))
      .limit(1);

    const passwordValid =
      user && user.activated && user.password
        ? await this.cryptoService.verifyPassword(dto.password, user.password)
        : false;

    await this.db.insert(loginAttempts).values({
      username: dto.username,
      remoteIp: meta.remoteIp ?? null,
      userAgent: meta.userAgent ?? null,
      successful: passwordValid,
      loginVia: 'local',
    });

    if (!user || !passwordValid) {
      throw new UnauthorizedException('Invalid username or password');
    }

    return this.completeUserAuthentication(user, { federatedMfaSatisfied: false });
  }

  async completeUserAuthentication(
    user: { id: number; twoFactorEnrolled: boolean },
    options: { federatedMfaSatisfied?: boolean } = {},
  ): Promise<LoginResponse> {
    const global2faRequired = await this.isGlobalTwoFactorRequired();
    const userRequires2fa = global2faRequired || Boolean(user.twoFactorEnrolled);

    if (userRequires2fa && !options.federatedMfaSatisfied) {
      const challengeToken = await this.jwtService.signTwoFactorChallenge({
        userId: user.id,
        requiresEnrollment: !user.twoFactorEnrolled,
      });
      return {
        status: '2fa_required',
        requiresTwoFactor: true,
        requiresEnrollment: !user.twoFactorEnrolled,
        challengeToken,
      };
    }

    await this.db
      .update(users)
      .set({ lastLogin: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id));

    return this.issueSessionForUser(user.id, true);
  }

  async enrollTwoFactor(userId: number): Promise<TwoFactorEnrollResponse> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);

    if (!user?.activated) {
      throw new UnauthorizedException('User account is inactive');
    }

    const [settingsRow] = await this.db.select().from(settings).limit(1);
    const policy = settingsRow?.twoFactorEnabled ?? TWO_FACTOR_POLICY.DISABLED;

    if (policy === TWO_FACTOR_POLICY.DISABLED) {
      throw new BadRequestException('Two-factor authentication is disabled globally');
    }

    if (user.twoFactorEnrolled && user.twoFactorSecret) {
      throw new BadRequestException('Two-factor authentication is already enrolled');
    }

    const secret = generateBase32Secret(20);
    const encryptedSecret = this.cryptoService.encrypt(secret);

    await this.db
      .update(users)
      .set({
        twoFactorSecret: encryptedSecret,
        twoFactorEnrolled: false,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    const issuer = settingsRow?.siteName || this.config.get('APP_NAME', { infer: true });
    const otpauthUri = buildOtpAuthUri({
      issuer,
      accountName: user.username,
      secret,
    });

    return { secret, otpauthUri };
  }

  async verifyTwoFactor(userId: number, code: string): Promise<LoginResponse> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);

    if (!user || !user.activated || !user.twoFactorSecret) {
      throw new UnauthorizedException('Two-factor authentication is not initialized for this user');
    }

    let decryptedSecret: string;
    try {
      decryptedSecret = user.twoFactorSecret.startsWith('enc:v1:')
        ? this.cryptoService.decrypt(user.twoFactorSecret)
        : user.twoFactorSecret;
    } catch {
      throw new UnauthorizedException('Invalid stored two-factor secret');
    }

    if (!verifyTotpCode(decryptedSecret, code, 1)) {
      throw new UnauthorizedException('Invalid two-factor verification code');
    }

    await this.db
      .update(users)
      .set({
        twoFactorEnrolled: true,
        lastLogin: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    return this.issueSessionForUser(user.id, true);
  }

  async refreshTokens(refreshToken: string): Promise<LoginResponse> {
    const payload = await this.jwtService.verifyToken<RefreshTokenPayload>(
      refreshToken,
      'refresh',
    );
    const userId = Number(payload.sub);
    const { jti, exp } = payload;
    if (!Number.isInteger(userId) || userId <= 0 || !jti || !exp) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    return this.db.transaction(async (tx) => {
      if (!(await this.consumeRefreshToken(jti, exp, tx))) {
        throw new UnauthorizedException('Refresh token has already been rotated or revoked');
      }
      return this.issueSessionForUser(userId, true, tx);
    });
  }

  async revokeRefreshToken(refreshToken?: string): Promise<void> {
    if (!refreshToken) return;

    const payload = await this.jwtService
      .verifyToken<RefreshTokenPayload>(refreshToken, 'refresh')
      .catch((error: unknown) => {
        if (!(error instanceof UnauthorizedException)) throw error;
        return undefined;
      });

    if (payload?.jti && payload.exp) {
      await this.consumeRefreshToken(payload.jti, payload.exp);
    }
  }

  async getAuthProvidersStatus(): Promise<AuthProvidersStatusResponse> {
    const [settingsRow] = await this.db
      .select({
        twoFactorEnabled: settings.twoFactorEnabled,
        oidcEnabled: settings.oidcEnabled,
        oidcIssuerUrl: settings.oidcIssuerUrl,
        oidcClientId: settings.oidcClientId,
      })
      .from(settings)
      .limit(1);

    const protocol: OAuthProtocol = this.config.get('OAUTH_PROTOCOL', { infer: true });
    const apiPrefix = trimSlashes(this.config.get('API_PREFIX', { infer: true }));
    const explicitEndpoints = Boolean(
      this.config.get('OAUTH_AUTHORIZATION_URL', { infer: true }) &&
        this.config.get('OAUTH_TOKEN_URL', { infer: true }),
    );
    const hasIssuerOrEndpoints = Boolean(
      settingsRow?.oidcIssuerUrl ||
        this.config.get('OIDC_ISSUER_URL', { infer: true }) ||
        explicitEndpoints,
    );
    const hasClientId = Boolean(
      settingsRow?.oidcClientId || this.config.get('OIDC_CLIENT_ID', { infer: true }),
    );
    const ssoEnabled = Boolean(
      this.isSsoEnabled(settingsRow?.oidcEnabled) &&
        hasIssuerOrEndpoints &&
        hasClientId,
    );

    const baEnabled = this.config.get('BETTER_AUTH_ENABLED', { infer: true });
    const baConfiguredMode = this.config.get('BETTER_AUTH_MODE', { infer: true });
    const enabledMode = baConfiguredMode === 'disabled' ? 'embedded' : baConfiguredMode;
    const baMode: BetterAuthMode = baEnabled ? enabledMode : 'disabled';
    const baPasskey =
      baEnabled && this.config.get('BETTER_AUTH_PASSKEY_ENABLED', { infer: true });
    const baProviders = baEnabled
      ? this.config
          .get('BETTER_AUTH_PROVIDERS', { infer: true })
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
      : [];

    return {
      local: true,
      twoFactorPolicy: settingsRow?.twoFactorEnabled ?? TWO_FACTOR_POLICY.DISABLED,
      sso: {
        enabled: ssoEnabled,
        protocol,
        loginPath: `/${apiPrefix}/auth/${protocol === 'oidc' ? 'oidc' : 'oauth'}/login`,
      },
      betterAuth: {
        enabled: baEnabled,
        mode: baMode,
        passkeyEnabled: baPasskey,
        providers: baProviders,
      },
    };
  }

  async buildOidcAuthorizationRedirect(redirect?: string): Promise<{
    redirectUrl: string;
    stateCookieToken: string;
  }> {
    const oidcConfig = await this.resolveOidcRuntimeConfig();
    const discovery = await this.discoverOidcEndpoints(oidcConfig.issuerUrl, oidcConfig.protocol);

    const state = randomBytes(16).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = computeS256CodeChallenge(codeVerifier);

    validateOAuth21AuthorizationRequest({
      responseType: 'code',
      codeChallenge,
      codeChallengeMethod: 'S256',
      codeVerifier,
      redirectUri: oidcConfig.redirectUri,
      expectedRedirectUri: oidcConfig.redirectUri,
    });

    const destination = sanitizeSsoRedirectPath(redirect);
    const stateCookieToken = await this.jwtService.signOidcState({
      state,
      nonce,
      codeVerifier,
      ...(destination !== '/dashboard' && destination !== '/' ? { redirect: destination } : {}),
    });

    const authUrl = new URL(discovery.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', oidcConfig.clientId);
    authUrl.searchParams.set('redirect_uri', oidcConfig.redirectUri);
    authUrl.searchParams.set('scope', oidcConfig.scopes);
    authUrl.searchParams.set('state', state);
    if (oidcConfig.protocol === 'oidc' || oidcConfig.scopes.split(/\s+/).includes('openid')) {
      authUrl.searchParams.set('nonce', nonce);
    }
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    return {
      redirectUrl: authUrl.toString(),
      stateCookieToken,
    };
  }

  async handleOidcCallback(params: {
    code: string;
    state: string;
    stateCookieToken: string;
    remoteIp?: string;
    userAgent?: string;
  }): Promise<LoginResponse> {
    const verifiedState = await this.jwtService.verifyToken<OidcStatePayload>(
      params.stateCookieToken,
      'oidc_state',
    );

    if (!params.state || verifiedState.state !== params.state) {
      throw new UnauthorizedException('OAuth/OIDC state mismatch');
    }

    const oidcConfig = await this.resolveOidcRuntimeConfig();
    validateOAuth21AuthorizationRequest({
      responseType: 'code',
      codeChallenge: computeS256CodeChallenge(verifiedState.codeVerifier),
      codeChallengeMethod: 'S256',
      codeVerifier: verifiedState.codeVerifier,
      redirectUri: oidcConfig.redirectUri,
      expectedRedirectUri: oidcConfig.redirectUri,
    });

    const discovery = await this.discoverOidcEndpoints(oidcConfig.issuerUrl, oidcConfig.protocol);

    const tokenPayload = await this.exchangeAuthorizationCode({
      tokenEndpoint: discovery.token_endpoint,
      code: params.code,
      redirectUri: oidcConfig.redirectUri,
      clientId: oidcConfig.clientId,
      clientSecret: oidcConfig.clientSecret,
      codeVerifier: verifiedState.codeVerifier,
    });

    const mergedClaims = await this.resolveOidcCallbackClaims({
      tokenPayload,
      discovery,
      oidcConfig,
      expectedNonce: verifiedState.nonce,
    });

    const user = await this.oidcProvisioning.resolveOrProvisionUser(mergedClaims);

    await this.db.insert(loginAttempts).values({
      username: user.username,
      remoteIp: params.remoteIp ?? null,
      userAgent: params.userAgent ?? null,
      successful: true,
      loginVia: oidcConfig.protocol,
    });

    return this.completeUserAuthentication(user, {
      federatedMfaSatisfied: AuthService.hasFederatedMfaClaim(mergedClaims),
    });
  }

  private async exchangeAuthorizationCode(params: {
    tokenEndpoint: string;
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
    codeVerifier: string;
  }): Promise<{ id_token?: string; access_token?: string }> {
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.codeVerifier,
    });
    if (params.clientSecret) {
      tokenBody.set('client_secret', params.clientSecret);
    }

    const tokenResponse = await fetch(params.tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: tokenBody.toString(),
    });

    if (!tokenResponse.ok) {
      throw new UnauthorizedException('Failed to exchange OAuth/OIDC authorization code');
    }

    return (await tokenResponse.json()) as {
      id_token?: string;
      access_token?: string;
    };
  }

  private async resolveOidcCallbackClaims(params: {
    tokenPayload: { id_token?: string; access_token?: string };
    discovery: OidcDiscoveryDoc;
    oidcConfig: { protocol: OAuthProtocol; issuerUrl: string; clientId: string };
    expectedNonce: string;
  }): Promise<Record<string, unknown>> {
    const { tokenPayload, discovery, oidcConfig, expectedNonce } = params;

    if (tokenPayload.id_token) {
      if (!discovery.jwks_uri) {
        throw new UnauthorizedException('OIDC discovery missing jwks_uri for id_token verification');
      }
      const idTokenClaims = await this.jwtService.verifyOidcIdToken(tokenPayload.id_token, {
        issuerUrl: oidcConfig.issuerUrl,
        clientId: oidcConfig.clientId,
        jwksUri: discovery.jwks_uri,
        expectedNonce,
      });

      const userInfoClaims = await this.fetchOptionalUserInfoClaims(
        discovery.userinfo_endpoint,
        tokenPayload.access_token,
      );

      return {
        ...userInfoClaims,
        ...idTokenClaims,
      };
    }

    if (oidcConfig.protocol !== 'oidc') {
      if (!tokenPayload.access_token || !discovery.userinfo_endpoint) {
        throw new UnauthorizedException(
          'OAuth 2.0/2.1 token response missing access_token or configured userinfo_endpoint',
        );
      }
      const rawUserInfo = await this.fetchRequiredUserInfoClaims(
        discovery.userinfo_endpoint,
        tokenPayload.access_token,
      );
      return normalizeOAuthUserInfoToClaims(rawUserInfo, {
        issuerUrl: oidcConfig.issuerUrl,
      });
    }

    throw new UnauthorizedException('OIDC token endpoint did not return an id_token');
  }

  private async fetchOptionalUserInfoClaims(
    userinfoEndpoint: string | undefined,
    accessToken: string | undefined,
  ): Promise<Record<string, unknown>> {
    if (!userinfoEndpoint || !accessToken) {
      return {};
    }
    try {
      const uiRes = await fetch(userinfoEndpoint, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
        },
      });
      if (uiRes.ok) {
        return (await uiRes.json()) as Record<string, unknown>;
      }
    } catch {
      // UserInfo is optional when ID token already carries the required claims.
    }
    return {};
  }

  private async fetchRequiredUserInfoClaims(
    userinfoEndpoint: string,
    accessToken: string,
  ): Promise<Record<string, unknown>> {
    const uiRes = await fetch(userinfoEndpoint, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
    });
    if (!uiRes.ok) {
      throw new UnauthorizedException('Failed to fetch OAuth userinfo profile');
    }
    return (await uiRes.json()) as Record<string, unknown>;
  }

  async issueSessionForUser(
    userId: number,
    twoFactorVerified: boolean,
    db: Pick<DrizzleDb, 'select'> = this.db,
  ): Promise<LoginResponse> {
    const userContext = await this.loadUserContext(userId, twoFactorVerified, 'jwt', db);
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAccessToken({
        userId: userContext.id,
        username: userContext.username,
        twoFactorVerified,
      }),
      this.jwtService.signRefreshToken({ userId: userContext.id }),
    ]);

    return {
      status: 'authenticated',
      accessToken,
      refreshToken,
      user: userContext,
    };
  }

  async loadUserContext(
    userId: number,
    twoFactorVerified: boolean,
    authMethod: 'jwt' | 'pat',
    db: Pick<DrizzleDb, 'select'> = this.db,
  ): Promise<AuthenticatedUserContext> {
    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);

    if (!user?.activated) {
      throw new UnauthorizedException('User account not found or inactive');
    }

    const groupRows = await db
      .select({
        id: groups.id,
        permissions: groups.permissions,
      })
      .from(usersGroups)
      .innerJoin(groups, eq(usersGroups.groupId, groups.id))
      .where(eq(usersGroups.userId, user.id));

    const userPerms: PermissionMap = user.permissions ?? {};
    const groupPermsList: PermissionMap[] = groupRows.map((g) => g.permissions ?? {});

    const effectivePermissions = resolveEffectivePermissions(userPerms, groupPermsList);
    const superUser = isSuperUser(userPerms, groupPermsList);
    const admin = isAdmin(userPerms, groupPermsList);

    const directCompanyRows = await db
      .select({ companyId: companyUser.companyId })
      .from(companyUser)
      .where(eq(companyUser.userId, user.id));

    const directCompanyIds = directCompanyRows.map((r) => r.companyId);
    let expandedCompanyIds = [...directCompanyIds];

    if (directCompanyIds.length > 0) {
      const childCompanies = await db
        .select({ id: companies.id })
        .from(companies)
        .where(and(inArray(companies.parentId, directCompanyIds), isNull(companies.deletedAt)));

      expandedCompanyIds = [
        ...new Set([...directCompanyIds, ...childCompanies.map((c) => c.id)]),
      ];
    }

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName:
        user.displayName || `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.username,
      isSuperUser: superUser,
      isAdmin: admin,
      userCompanyIds: expandedCompanyIds,
      groupIds: groupRows.map((g) => g.id),
      effectivePermissions,
      keyPermissions: Object.fromEntries(
        ALL_PERMISSIONS.map((key) => [key, hasKeyAccess(userPerms, groupPermsList, key)]),
      ) as AuthenticatedUserContext['keyPermissions'],
      twoFactorEnrolled: user.twoFactorEnrolled,
      twoFactorVerified,
      authMethod,
    };
  }

  async isGlobalTwoFactorRequired(): Promise<boolean> {
    const [settingsRow] = await this.db
      .select({ twoFactorEnabled: settings.twoFactorEnabled })
      .from(settings)
      .limit(1);
    return settingsRow?.twoFactorEnabled === TWO_FACTOR_POLICY.REQUIRED;
  }

  async canUserEnrollTwoFactor(userId: number): Promise<boolean> {
    const context = await this.loadUserContext(userId, true, 'jwt');
    return hasAccess(
      {},
      [
        Object.fromEntries(
          Object.entries(context.effectivePermissions).map(([k, v]) => [k, v ? 1 : 0]),
        ) as PermissionMap,
      ],
      'self.two_factor',
    );
  }

  @Cron(CronExpression.EVERY_HOUR)
  async clearExpiredAuthConsumptions(): Promise<void> {
    await this.db.delete(authConsumedTokens).where(lte(authConsumedTokens.expiresAt, new Date()));
  }

  private async consumeRefreshToken(
    jti: string,
    expiresAt: number,
    db: Pick<DrizzleDb, 'insert'> = this.db,
  ): Promise<boolean> {
    const [claimed] = await db
      .insert(authConsumedTokens)
      .values({
        digest: `refresh_jti:${this.cryptoService.sha256Hex(jti)}`,
        expiresAt: new Date(expiresAt * 1000),
      })
      .onConflictDoNothing()
      .returning({ digest: authConsumedTokens.digest });
    return Boolean(claimed);
  }

  private isSsoEnabled(stored?: boolean): boolean {
    return this.config.get('OIDC_ENABLED', { infer: true }) ?? stored ?? false;
  }

  private async resolveOidcRuntimeConfig() {
    const [settingsRow] = await this.db.select().from(settings).limit(1);
    const enabled = this.isSsoEnabled(settingsRow?.oidcEnabled);
    const protocol: OAuthProtocol = this.config.get('OAUTH_PROTOCOL', { infer: true });
    const authUrlOverride = this.config.get('OAUTH_AUTHORIZATION_URL', { infer: true });
    const tokenUrlOverride = this.config.get('OAUTH_TOKEN_URL', { infer: true });

    let issuerUrl = trimTrailingCharacter(
      settingsRow?.oidcIssuerUrl || this.config.get('OIDC_ISSUER_URL', { infer: true }) || '',
      '/',
    );

    if (!issuerUrl && authUrlOverride) {
      try {
        issuerUrl = new URL(authUrlOverride).origin;
      } catch {
        issuerUrl = '';
      }
    }

    const clientId =
      settingsRow?.oidcClientId || this.config.get('OIDC_CLIENT_ID', { infer: true }) || '';

    let clientSecret = this.config.get('OIDC_CLIENT_SECRET', { infer: true }) || '';
    if (settingsRow?.oidcClientSecretEncrypted) {
      clientSecret = settingsRow.oidcClientSecretEncrypted.startsWith('enc:v1:')
        ? this.cryptoService.decrypt(settingsRow.oidcClientSecretEncrypted)
        : settingsRow.oidcClientSecretEncrypted;
    }

    const appUrl = trimTrailingCharacter(this.config.get('APP_URL', { infer: true }), '/');
    const apiPrefix = trimSlashes(this.config.get('API_PREFIX', { infer: true }));
    const callbackSegment = protocol === 'oidc' ? 'oidc' : 'oauth';
    const redirectUri =
      this.config.get('OIDC_REDIRECT_URI', { infer: true }) ||
      `${appUrl}/${apiPrefix}/auth/${callbackSegment}/callback`;
    const scopes =
      this.config.get('OIDC_SCOPES', { infer: true }) ||
      settingsRow?.oidcScopes ||
      'openid profile email groups';

    const hasExplicitEndpoints = Boolean(authUrlOverride && tokenUrlOverride);
    if (!enabled || (!issuerUrl && !hasExplicitEndpoints) || !clientId) {
      throw new BadRequestException('OIDC/OAuth authentication is not enabled or configured');
    }

    return { protocol, issuerUrl, clientId, clientSecret, redirectUri, scopes };
  }

  private async discoverOidcEndpoints(
    issuerUrl: string,
    protocol: OAuthProtocol,
  ): Promise<OidcDiscoveryDoc> {
    const authUrlOverride = this.config.get('OAUTH_AUTHORIZATION_URL', { infer: true });
    const tokenUrlOverride = this.config.get('OAUTH_TOKEN_URL', { infer: true });
    const userinfoUrlOverride = this.config.get('OAUTH_USERINFO_URL', { infer: true });

    if (authUrlOverride && tokenUrlOverride) {
      return {
        authorization_endpoint: authUrlOverride,
        token_endpoint: tokenUrlOverride,
        userinfo_endpoint: userinfoUrlOverride || undefined,
      };
    }

    const cacheKey = `${protocol}:${issuerUrl}`;
    const cached = this.oidcDiscoveryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.doc;
    }

    let response = await fetch(`${issuerUrl}/.well-known/openid-configuration`);
    if (!response.ok && protocol !== 'oidc') {
      // RFC 8414 OAuth 2.0 / 2.1 Authorization Server Metadata fallback
      response = await fetch(`${issuerUrl}/.well-known/oauth-authorization-server`);
    }

    if (!response.ok) {
      throw new UnauthorizedException('Failed to fetch OIDC/OAuth discovery document');
    }

    const doc = (await response.json()) as OidcDiscoveryDoc;
    const missingJwksForOidc = protocol === 'oidc' && !doc.jwks_uri;
    if (!doc.authorization_endpoint || !doc.token_endpoint || missingJwksForOidc) {
      throw new UnauthorizedException('Incomplete OIDC/OAuth discovery document');
    }

    if (userinfoUrlOverride && !doc.userinfo_endpoint) {
      doc.userinfo_endpoint = userinfoUrlOverride;
    }

    this.oidcDiscoveryCache.set(cacheKey, {
      expiresAt: Date.now() + 3_600_000,
      doc,
    });
    return doc;
  }
}

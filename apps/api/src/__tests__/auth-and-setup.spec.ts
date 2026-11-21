import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALL_PERMISSIONS, type AuthenticatedUserContext } from '@kestrel-it/shared';
import bcrypt from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';
import { CryptoService } from '../common/crypto/crypto.service.js';
import { JwtService } from '../common/crypto/jwt.util.js';
import {
  buildOtpAuthUri,
  generateBase32Secret,
  generateTotpCode,
  verifyTotpCode,
} from '../common/crypto/totp.util.js';
import { PermissionsGuard } from '../common/guards/permissions.guard.js';
import { validateEnv } from '../config/env.schema.js';
import {
  actionLogs,
  companyUser,
  groups,
  personalAccessTokens,
  settings,
  users,
  usersGroups,
} from '../db/schema/index.js';
import { AuthService } from '../modules/auth/auth.service.js';
import { BetterAuthService } from '../modules/auth/better-auth.service.js';
import {
  computeS256CodeChallenge,
  normalizeOAuthUserInfoToClaims,
  validateOAuth21AuthorizationRequest,
} from '../modules/auth/oauth21.util.js';
import { OidcUserProvisioningService } from '../modules/auth/oidc-provisioning.service.js';
import { PatService } from '../modules/auth/pat.service.js';
import { SetupNotCompletedGuard } from '../modules/setup/setup-not-completed.guard.js';
import { SetupService } from '../modules/setup/setup.service.js';

function makeConfigMock(overrides: Record<string, unknown> = {}) {
  const env = validateEnv({
    APP_ENCRYPTION_KEY: 'a'.repeat(64),
    JWT_SECRET: 'test-jwt-secret-minimum-16-chars-long',
    ...overrides,
  });
  return {
    get: (key: keyof typeof env) => env[key],
  } as unknown as ConstructorParameters<typeof CryptoService>[0];
}

function makePermissionsMap(grants: string[] = []): AuthenticatedUserContext['effectivePermissions'] {
  const map = {} as AuthenticatedUserContext['effectivePermissions'];
  for (const key of ALL_PERMISSIONS) {
    map[key] = grants.includes(key);
  }
  return map;
}

describe('CryptoService & TOTP RFC 6238', () => {
  it('encrypts/decrypts AES-256-GCM and verifies scrypt + legacy Snipe-IT $2y$ bcrypt hashes', async () => {
    const crypto = new CryptoService(makeConfigMock());

    const encrypted = crypto.encrypt('JBSWY3DPEHPK3PXP');
    expect(encrypted.startsWith('enc:v1:')).toBe(true);
    expect(crypto.decrypt(encrypted)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => crypto.decrypt('invalid-payload')).toThrow();

    const scryptHash = crypto.hashPassword('StrongPass123!');
    expect(scryptHash.startsWith('scrypt:')).toBe(true);
    expect(await crypto.verifyPassword('StrongPass123!', scryptHash)).toBe(true);
    expect(await crypto.verifyPassword('WrongPass', scryptHash)).toBe(false);

    // Simulate legacy Laravel/Snipe-IT $2y$ bcrypt password hash
    const bcrypt2a = bcrypt.hashSync('LegacySnipePass!', 4);
    const legacy2y = bcrypt2a.replace(/^\$2a\$/, '$2y$');
    expect(await crypto.verifyPassword('LegacySnipePass!', legacy2y)).toBe(true);
    expect(await crypto.verifyPassword('WrongLegacyPass', legacy2y)).toBe(false);

    const pat = crypto.generatePatToken();
    expect(pat.token.startsWith('kst_')).toBe(true);
    expect(pat.tokenHash).toBe(crypto.sha256Hex(pat.token));
  });

  it('generates and verifies 6-digit TOTP codes within +/- 1 step window', () => {
    const secret = generateBase32Secret(20);
    expect(secret.length).toBeGreaterThanOrEqual(32);

    const uri = buildOtpAuthUri({
      issuer: 'Kestrel-IT',
      accountName: 'alice',
      secret,
    });
    expect(uri).toContain('otpauth://totp/Kestrel-IT:alice');
    expect(uri).toContain(`secret=${secret}`);

    const nowMs = 1_700_000_000_000;
    const validCode = generateTotpCode(secret, nowMs);
    expect(validCode).toMatch(/^\d{6}$/);
    expect(verifyTotpCode(secret, validCode, 1, nowMs)).toBe(true);
    expect(verifyTotpCode(secret, validCode, 1, nowMs + 30_000)).toBe(true);
    expect(verifyTotpCode(secret, '000000', 0, nowMs + 900_000)).toBe(false);
    expect(verifyTotpCode(secret, 'abc', 1, nowMs)).toBe(false);
  });
});

describe('JwtService', () => {
  it('signs and verifies access, refresh, 2fa_challenge, and oidc_state tokens with strict type checks', async () => {
    const jwt = new JwtService(makeConfigMock());

    const access = await jwt.signAccessToken({
      userId: 42,
      username: 'alice',
      twoFactorVerified: true,
    });
    const accessPayload = await jwt.verifyToken(access, 'access');
    expect(accessPayload.sub).toBe('42');
    expect(accessPayload.twoFactorVerified).toBe(true);
    await expect(jwt.verifyToken(access, 'refresh')).rejects.toThrow(UnauthorizedException);

    const challenge = await jwt.signTwoFactorChallenge({
      userId: 42,
      requiresEnrollment: true,
    });
    const challengePayload = await jwt.verifyToken(challenge, '2fa_challenge');
    expect(challengePayload.requiresEnrollment).toBe(true);
    await expect(jwt.verifyToken(challenge, 'access')).rejects.toThrow(UnauthorizedException);

    const oidcState = await jwt.signOidcState({
      state: 's1',
      nonce: 'n1',
      codeVerifier: 'v1',
    });
    const oidcPayload = await jwt.verifyToken(oidcState, 'oidc_state');
    expect(oidcPayload.codeVerifier).toBe('v1');
  });
});

describe('SetupNotCompletedGuard & SetupService', () => {
  it('blocks setup writes with 403 once setup is completed', async () => {
    const incompleteGuard = new SetupNotCompletedGuard({
      isSetupCompleted: async () => false,
    } as unknown as ConstructorParameters<typeof SetupNotCompletedGuard>[0]);
    expect(await incompleteGuard.canActivate()).toBe(true);

    const completedGuard = new SetupNotCompletedGuard({
      isSetupCompleted: async () => true,
    } as unknown as ConstructorParameters<typeof SetupNotCompletedGuard>[0]);
    await expect(completedGuard.canActivate()).rejects.toThrow(ForbiddenException);
  });

  it('completes initial setup transactionally and rejects duplicate attempts', async () => {
    const insertedTables: unknown[] = [];
    const txMock = {
      insert: (table: unknown) => ({
        values: (vals: unknown) => {
          insertedTables.push({ table, vals });
          return {
            returning: async () => [{ id: 1 }],
          };
        },
      }),
    };
    const dbMock = {
      transaction: async (cb: (tx: typeof txMock) => Promise<number>) => cb(txMock),
    } as unknown as ConstructorParameters<typeof SetupService>[0];

    let completed = false;
    const bootstrapMock = {
      isSetupCompleted: async () => completed,
      seedDefaultStatusLabels: vi.fn(async () => undefined),
    } as unknown as ConstructorParameters<typeof SetupService>[2];

    const crypto = new CryptoService(makeConfigMock());
    const authMock = {
      issueSessionForUser: vi.fn(async (id: number) => ({
        status: 'authenticated' as const,
        accessToken: 'acc',
        refreshToken: 'ref',
        user: { id } as AuthenticatedUserContext,
      })),
    } as unknown as ConstructorParameters<typeof SetupService>[4];

    const service = new SetupService(
      dbMock,
      makeConfigMock(),
      bootstrapMock,
      crypto,
      authMock,
    );

    const res = await service.completeSetup({
      siteName: 'Kestrel Test',
      locale: 'en-US',
      defaultCurrency: 'EUR',
      fullMultipleCompaniesSupport: false,
      autoIncrementAssets: true,
      autoIncrementPrefix: 'KST-',
      zerofillCount: 5,
      firstName: 'Marco',
      lastName: 'Admin',
      username: 'marco',
      email: 'marco@example.com',
      password: 'SuperSecurePassword123',
    });

    expect(res.status).toBe('authenticated');
    expect(insertedTables.map((i) => (i as { table: unknown }).table)).toEqual([
      users,
      settings,
      actionLogs,
    ]);

    completed = true;
    await expect(
      service.completeSetup({
        siteName: 'Kestrel Test',
        locale: 'en-US',
        defaultCurrency: 'EUR',
        fullMultipleCompaniesSupport: false,
        autoIncrementAssets: false,
        zerofillCount: 5,
        firstName: 'Marco',
        lastName: 'Admin',
        username: 'marco',
        email: 'marco@example.com',
        password: 'SuperSecurePassword123',
      }),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('OidcUserProvisioningService (JIT + Linking)', () => {
  const baseSettings = {
    oidcAutoProvisionUsers: true,
    oidcLinkExistingUsers: true,
    oidcSyncOnLogin: true,
    oidcSyncGroups: true,
    oidcUsernameClaim: 'preferred_username',
    oidcGroupsClaim: 'groups',
    oidcDefaultGroupId: 2,
    oidcDefaultCompanyId: 10,
    oidcGroupMapping: { 'it-admins': 5 },
    locale: 'en-US',
  };

  it('resolves directly by (oidcIssuer, oidcSubject) when already linked', async () => {
    const existingUser = {
      id: 7,
      username: 'alice',
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Rossi',
      displayName: 'Alice Rossi',
      employeeNum: null,
      jobtitle: null,
      phone: null,
      locale: 'en-US',
      activated: true,
      oidcIssuer: 'https://idp.example.com',
      oidcSubject: 'sub-7',
    };

    let selectCount = 0;
    const dbMock = {
      select: () => ({
        from: (table: unknown) => ({
          limit: async () => {
            if (table === settings) return [{ ...baseSettings, oidcSyncOnLogin: false }];
            return [];
          },
          where: () => ({
            limit: async () => {
              selectCount += 1;
              return selectCount === 1 ? [existingUser] : [];
            },
          }),
        }),
      }),
    } as unknown as ConstructorParameters<typeof OidcUserProvisioningService>[0];

    const svc = new OidcUserProvisioningService(dbMock, makeConfigMock());
    const user = await svc.resolveOrProvisionUser({
      iss: 'https://idp.example.com',
      sub: 'sub-7',
    });
    expect(user.id).toBe(7);
  });

  it('links and pins pre-existing user via username fallback when (iss, sub) is unset', async () => {
    const existingUser = {
      id: 9,
      username: 'bob',
      email: 'bob@example.com',
      firstName: 'Bob',
      lastName: 'Verdi',
      displayName: 'Bob Verdi',
      employeeNum: null,
      jobtitle: null,
      phone: null,
      locale: 'en-US',
      activated: true,
      oidcIssuer: null,
      oidcSubject: null,
    };

    const pinnedUpdates: unknown[] = [];
    const dbMock = {
      select: () => ({
        from: (table: unknown) => ({
          limit: async () => (table === settings ? [{ ...baseSettings, oidcSyncOnLogin: false }] : []),
          where: () => ({
            limit: async () => {
              // First query is tuple match -> empty; second query is username fallback -> existingUser
              return pinnedUpdates.length === 0 && existingUser ? [existingUser] : [];
            },
          }),
        }),
      }),
      update: () => ({
        set: (data: unknown) => {
          pinnedUpdates.push(data);
          return {
            where: () => ({
              returning: async () => [{ ...existingUser, ...(data as object) }],
            }),
          };
        },
      }),
    } as unknown as ConstructorParameters<typeof OidcUserProvisioningService>[0];

    // Refine select mock so first where() returns [] and second returns [existingUser]
    let whereCalls = 0;
    (dbMock as unknown as { select: unknown }).select = () => ({
      from: (table: unknown) => ({
        limit: async () => (table === settings ? [{ ...baseSettings, oidcSyncOnLogin: false }] : []),
        where: () => ({
          limit: async () => {
            whereCalls += 1;
            return whereCalls === 2 ? [existingUser] : [];
          },
        }),
      }),
    });

    const svc = new OidcUserProvisioningService(dbMock, makeConfigMock());
    const user = await svc.resolveOrProvisionUser({
      iss: 'https://idp.example.com',
      sub: 'sub-9',
      preferred_username: 'bob',
    });

    expect(user.oidcIssuer).toBe('https://idp.example.com');
    expect(user.oidcSubject).toBe('sub-9');
    expect(pinnedUpdates).toHaveLength(1);
  });

  it('auto-provisions new user Just-In-Time with action log, group sync, and company assignment', async () => {
    const insertedOps: Array<{ table: unknown; values: unknown }> = [];

    const txMock = {
      insert: (table: unknown) => ({
        values: (values: unknown) => {
          insertedOps.push({ table, values });
          return {
            returning: async () => [
              {
                id: 101,
                ...(values as object),
              },
            ],
            onConflictDoNothing: async () => undefined,
          };
        },
      }),
      delete: () => ({
        where: async () => undefined,
      }),
    };

    const dbMock = {
      select: () => ({
        from: (table: unknown) => ({
          limit: async () => (table === settings ? [baseSettings] : []),
          where: () => {
            if (table === groups) {
              return Promise.resolve([{ id: 8 }]);
            }
            return {
              limit: async () => [],
            };
          },
        }),
      }),
      insert: txMock.insert,
      transaction: async (cb: (tx: typeof txMock) => Promise<unknown>) => cb(txMock),
    } as unknown as ConstructorParameters<typeof OidcUserProvisioningService>[0];

    const svc = new OidcUserProvisioningService(dbMock, makeConfigMock());
    const created = await svc.resolveOrProvisionUser({
      iss: 'https://keycloak.example.com/realms/main',
      sub: 'kc-uuid-101',
      preferred_username: 'giulia.bianchi',
      email: 'giulia.bianchi@example.com',
      given_name: 'Giulia',
      family_name: 'Bianchi',
      name: 'Giulia Bianchi',
      groups: ['it-admins', 'helpdesk'],
    });

    expect(created.id).toBe(101);
    expect(created.username).toBe('giulia.bianchi');

    const userInsert = insertedOps.find((op) => op.table === users);
    expect(userInsert).toBeDefined();

    const logInsert = insertedOps.find((op) => op.table === actionLogs);
    expect((logInsert?.values as { actionSource?: string })?.actionSource).toBe('oidc_jit');

    const groupInserts = insertedOps.find((op) => op.table === usersGroups);
    expect(groupInserts?.values).toEqual([
      { userId: 101, groupId: 2 },
      { userId: 101, groupId: 5 },
      { userId: 101, groupId: 8 },
    ]);

    const companyInsert = insertedOps.find((op) => op.table === companyUser);
    expect(companyInsert?.values).toEqual({ userId: 101, companyId: 10 });
  });

  it('rejects unknown OIDC user when oidcAutoProvisionUsers is false', async () => {
    const dbMock = {
      select: () => ({
        from: (table: unknown) => ({
          limit: async () =>
            table === settings ? [{ ...baseSettings, oidcAutoProvisionUsers: false }] : [],
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    } as unknown as ConstructorParameters<typeof OidcUserProvisioningService>[0];

    const svc = new OidcUserProvisioningService(dbMock, makeConfigMock());
    await expect(
      svc.resolveOrProvisionUser({
        iss: 'https://idp.example.com',
        sub: 'unknown-sub',
        preferred_username: 'ghost',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });
});

describe('PatService & PermissionsGuard', () => {
  it('enforces self.api + 2FA verified and authenticates PAT via SHA-256 digest', async () => {
    const crypto = new CryptoService(makeConfigMock());
    const storedTokens: Array<Record<string, unknown>> = [];

    const dbMock = {
      insert: (table: unknown) => ({
        values: (vals: Record<string, unknown>) => ({
          returning: async () => {
            expect(table).toBe(personalAccessTokens);
            const row = {
              id: '11111111-1111-1111-1111-111111111111',
              ...vals,
              lastUsedAt: null,
              revokedAt: null,
              createdAt: new Date('2026-11-21T10:00:00Z'),
            };
            storedTokens.push(row);
            return [row];
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => storedTokens,
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => undefined,
        }),
      }),
    } as unknown as ConstructorParameters<typeof PatService>[0];

    const userWithApi: AuthenticatedUserContext = {
      id: 1,
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      isSuperUser: false,
      isAdmin: false,
      userCompanyIds: [],
      groupIds: [],
      effectivePermissions: makePermissionsMap(['self.api']),
      twoFactorEnrolled: true,
      twoFactorVerified: true,
      authMethod: 'jwt',
    };

    const authServiceMock = {
      loadUserContext: vi.fn(async () => ({ ...userWithApi, authMethod: 'pat' as const })),
    } as unknown as ConstructorParameters<typeof PatService>[2];

    const patService = new PatService(dbMock, crypto, authServiceMock);

    // Reject missing self.api
    await expect(
      patService.createToken(
        { ...userWithApi, effectivePermissions: makePermissionsMap([]) },
        { name: 'CI Token' },
      ),
    ).rejects.toThrow(ForbiddenException);

    // Reject unverified 2FA
    await expect(
      patService.createToken({ ...userWithApi, twoFactorVerified: false }, { name: 'CI Token' }),
    ).rejects.toThrow(ForbiddenException);

    // Create & authenticate valid token
    const created = await patService.createToken(userWithApi, { name: 'CLI Token' });
    expect(created.token.startsWith('kst_')).toBe(true);
    expect(storedTokens[0]?.['tokenHash']).toBe(crypto.sha256Hex(created.token));

    const authed = await patService.authenticatePat(created.token);
    expect(authed.authMethod).toBe('pat');
    expect(authed.id).toBe(1);
  });

  it('evaluates required RBAC permissions in PermissionsGuard', () => {
    const reflector = {
      getAllAndOverride: () => ['assets.view', 'assets.checkout'],
    } as unknown as Reflector;
    const guard = new PermissionsGuard(reflector);

    const makeContext = (user?: AuthenticatedUserContext) =>
      ({
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({ user }),
        }),
      }) as unknown as ExecutionContext;

    expect(
      guard.canActivate(
        makeContext({
          id: 1,
          username: 'u',
          email: null,
          displayName: 'U',
          isSuperUser: false,
          isAdmin: false,
          userCompanyIds: [],
          groupIds: [],
          effectivePermissions: makePermissionsMap(['assets.view', 'assets.checkout']),
          twoFactorEnrolled: false,
          twoFactorVerified: true,
          authMethod: 'jwt',
        }),
      ),
    ).toBe(true);

    expect(() =>
      guard.canActivate(
        makeContext({
          id: 1,
          username: 'u',
          email: null,
          displayName: 'U',
          isSuperUser: false,
          isAdmin: false,
          userCompanyIds: [],
          groupIds: [],
          effectivePermissions: makePermissionsMap(['assets.view']),
          twoFactorEnrolled: false,
          twoFactorVerified: true,
          authMethod: 'jwt',
        }),
      ),
    ).toThrow(ForbiddenException);
  });
});

describe('OAuth 2.0 / OAuth 2.1 (PKCE S256 & UserInfo Normalization)', () => {
  it('enforces OAuth 2.1 invariants (blocks implicit/ROPC/plain PKCE, verifies S256 & exact redirect URI)', () => {
    const validVerifier = 'a'.repeat(43);
    const validChallenge = computeS256CodeChallenge(validVerifier);

    expect(() =>
      validateOAuth21AuthorizationRequest({
        responseType: 'code',
        codeChallenge: validChallenge,
        codeChallengeMethod: 'S256',
        codeVerifier: validVerifier,
        redirectUri: 'https://kestrel.example.com/api/v1/auth/oauth/callback',
        expectedRedirectUri: 'https://kestrel.example.com/api/v1/auth/oauth/callback',
      }),
    ).not.toThrow();

    // Disallow deprecated implicit grant ('token') and ROPC ('password')
    expect(() =>
      validateOAuth21AuthorizationRequest({
        responseType: 'token',
        codeChallenge: validChallenge,
        codeChallengeMethod: 'S256',
      }),
    ).toThrow(BadRequestException);

    expect(() =>
      validateOAuth21AuthorizationRequest({
        responseType: 'password',
        codeChallenge: validChallenge,
        codeChallengeMethod: 'S256',
      }),
    ).toThrow(BadRequestException);

    // Disallow 'plain' PKCE method
    expect(() =>
      validateOAuth21AuthorizationRequest({
        responseType: 'code',
        codeChallenge: validVerifier,
        codeChallengeMethod: 'plain',
      }),
    ).toThrow(BadRequestException);

    // Reject mismatched verifier
    expect(() =>
      validateOAuth21AuthorizationRequest({
        responseType: 'code',
        codeChallenge: validChallenge,
        codeChallengeMethod: 'S256',
        codeVerifier: 'b'.repeat(43),
      }),
    ).toThrow(UnauthorizedException);

    // Reject redirect_uri mismatch or plain http outside localhost
    expect(() =>
      validateOAuth21AuthorizationRequest({
        responseType: 'code',
        codeChallenge: validChallenge,
        codeChallengeMethod: 'S256',
        redirectUri: 'https://evil.example.com/callback',
        expectedRedirectUri: 'https://kestrel.example.com/api/v1/auth/oauth/callback',
      }),
    ).toThrow(BadRequestException);

    expect(() =>
      validateOAuth21AuthorizationRequest({
        responseType: 'code',
        codeChallenge: validChallenge,
        codeChallengeMethod: 'S256',
        redirectUri: 'http://kestrel.example.com/callback',
      }),
    ).toThrow(BadRequestException);
  });

  it('normalizes pure OAuth 2.0/2.1 userinfo profiles (GitHub/GitLab/Nextcloud) to OIDC claims', () => {
    const githubClaims = normalizeOAuthUserInfoToClaims(
      {
        id: 9981,
        login: 'octo.tech',
        name: 'Octo Tech',
        email: 'octo@example.com',
        teams: [{ name: 'it-admins' }, 'support'],
      },
      { issuerUrl: 'https://github.com' },
    );

    expect(githubClaims).toEqual({
      iss: 'https://github.com',
      sub: '9981',
      preferred_username: 'octo.tech',
      email: 'octo@example.com',
      email_verified: true,
      name: 'Octo Tech',
      groups: ['it-admins', 'support'],
    });

    const nextcloudClaims = normalizeOAuthUserInfoToClaims(
      {
        ocs: {
          data: {
            id: 'nc-42',
            displayname: 'Laura Bianchi',
            email: 'laura@example.com',
            groups: ['helpdesk'],
          },
        },
      },
      { issuerUrl: 'https://cloud.example.com' },
    );

    expect(nextcloudClaims['sub']).toBe('nc-42');
    expect(nextcloudClaims['name']).toBe('Laura Bianchi');
    expect(nextcloudClaims['groups']).toEqual(['helpdesk']);

    expect(() =>
      normalizeOAuthUserInfoToClaims({ email: 'anon@example.com' }, { issuerUrl: 'https://idp' }),
    ).toThrow(UnauthorizedException);
  });

  it('enforces OAuth 2.1 Refresh Token Rotation by rejecting replayed jti tokens', async () => {
    const config = makeConfigMock();
    const crypto = new CryptoService(config);
    const jwt = new JwtService(config);
    const dbMock = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    } as unknown as ConstructorParameters<typeof AuthService>[0];

    const authService = new AuthService(
      dbMock,
      config,
      crypto,
      jwt,
      new OidcUserProvisioningService(dbMock, config),
    );

    vi.spyOn(authService, 'issueSessionForUser').mockImplementation(async (userId) => ({
      status: 'authenticated',
      accessToken: `acc-${userId}`,
      refreshToken: await jwt.signRefreshToken({ userId }),
      user: {
        id: userId,
        username: 'alice',
        email: 'alice@example.com',
        displayName: 'Alice',
        isSuperUser: false,
        isAdmin: false,
        userCompanyIds: [],
        groupIds: [],
        effectivePermissions: makePermissionsMap([]),
        twoFactorEnrolled: false,
        twoFactorVerified: true,
        authMethod: 'jwt',
      },
    }));

    const initialRefreshToken = await jwt.signRefreshToken({ userId: 7 });
    const rotated = await authService.refreshTokens(initialRefreshToken);
    expect(rotated.status).toBe('authenticated');

    // Replaying the same refresh token (same jti) must fail under OAuth 2.1 rotation
    await expect(authService.refreshTokens(initialRefreshToken)).rejects.toThrow(
      UnauthorizedException,
    );

    // Using the newly rotated refresh token succeeds
    if (rotated.status === 'authenticated') {
      const rotatedAgain = await authService.refreshTokens(rotated.refreshToken);
      expect(rotatedAgain.status).toBe('authenticated');
    }
  });
});

describe('BetterAuthService & BetterAuthProvisioningBridge', () => {
  it('builds Drizzle adapter config, enforces HMAC signature, and bridges to JIT provisioning + RBAC', async () => {
    const config = makeConfigMock({
      BETTER_AUTH_ENABLED: 'true',
      BETTER_AUTH_MODE: 'embedded',
      BETTER_AUTH_SECRET: 'better-auth-super-secret-32-chars!!',
      BETTER_AUTH_PASSKEY_ENABLED: 'true',
      BETTER_AUTH_PROVIDERS: 'github,keycloak,passkey',
    });

    const loginAttemptInserts: unknown[] = [];
    const lastLoginUpdates: unknown[] = [];

    const dbMock = {
      update: () => ({
        set: (vals: unknown) => {
          lastLoginUpdates.push(vals);
          return {
            where: async () => undefined,
          };
        },
      }),
      insert: (table: unknown) => ({
        values: async (vals: unknown) => {
          loginAttemptInserts.push({ table, vals });
          return undefined;
        },
      }),
    } as unknown as ConstructorParameters<typeof BetterAuthService>[0];

    const provisionedUser = {
      id: 55,
      username: 'elena.neri',
      email: 'elena.neri@example.com',
      activated: true,
    } as Awaited<ReturnType<OidcUserProvisioningService['resolveOrProvisionUser']>>;

    const oidcProvisioningMock = {
      resolveOrProvisionUser: vi.fn(async () => provisionedUser),
    } as unknown as OidcUserProvisioningService;

    const authServiceMock = {
      issueSessionForUser: vi.fn(async (userId: number) => ({
        status: 'authenticated' as const,
        accessToken: 'jwt-ba-acc',
        refreshToken: 'jwt-ba-ref',
        user: {
          id: userId,
          username: 'elena.neri',
          email: 'elena.neri@example.com',
          displayName: 'Elena Neri',
          isSuperUser: false,
          isAdmin: true,
          userCompanyIds: [3],
          groupIds: [2],
          effectivePermissions: makePermissionsMap(['admin', 'assets.view']),
          twoFactorEnrolled: false,
          twoFactorVerified: true,
          authMethod: 'jwt' as const,
        },
      })),
    } as unknown as AuthService;

    const baService = new BetterAuthService(
      dbMock,
      config,
      oidcProvisioningMock,
      authServiceMock,
    );

    const status = baService.getStatus();
    expect(status).toEqual({
      enabled: true,
      mode: 'embedded',
      passkeyEnabled: true,
      providers: ['github', 'keycloak', 'passkey'],
    });

    const drizzleConfig = baService.buildBetterAuthDrizzleConfig();
    expect(drizzleConfig.database.adapter).toBe('drizzle');
    expect(drizzleConfig.database.provider).toBe('pg');
    expect(drizzleConfig.plugins.genericOAuth.codeChallengeMethod).toBe('S256');
    expect(drizzleConfig.plugins.passkey.enabled).toBe(true);

    // Database hook executes OidcUserProvisioningService with better-auth issuer prefix
    await drizzleConfig.databaseHooks.user.create.after({
      id: 'ba-user-55',
      email: 'elena.neri@example.com',
      emailVerified: true,
      username: 'elena.neri',
      groups: ['it-admins'],
      providerId: 'keycloak',
    });
    expect(oidcProvisioningMock.resolveOrProvisionUser).toHaveBeenCalledWith(
      expect.objectContaining({
        iss: 'better-auth:keycloak',
        sub: 'ba-user-55',
        email: 'elena.neri@example.com',
        groups: ['it-admins'],
      }),
    );

    const userPayload = {
      id: 'ba-user-55',
      email: 'elena.neri@example.com',
      emailVerified: true,
      username: 'elena.neri',
      firstName: 'Elena',
      lastName: 'Neri',
      groups: ['it-admins'],
    };
    const validSignature = baService.signBetterAuthBridgePayload({
      providerId: 'github',
      user: userPayload,
    });

    // Tampered signature must fail
    await expect(
      baService.exchangeSession({
        providerId: 'github',
        user: userPayload,
        signature: '0'.repeat(64),
      }),
    ).rejects.toThrow(UnauthorizedException);

    // Valid signed payload completes exchange and returns RBAC session
    const session = await baService.exchangeSession(
      {
        providerId: 'github',
        user: userPayload,
        signature: validSignature,
      },
      { remoteIp: '10.0.0.5', userAgent: 'Vitest' },
    );

    expect(session.status).toBe('authenticated');
    if (session.status === 'authenticated') {
      expect(session.user.id).toBe(55);
      expect(session.user.effectivePermissions['assets.view']).toBe(true);
    }
    expect(lastLoginUpdates).toHaveLength(1);
    expect((loginAttemptInserts[0] as { vals: { loginVia: string } }).vals.loginVia).toBe(
      'better-auth',
    );
  });
});

describe('OIDC Subject Pinning & Federated MFA Policy Enforcement', () => {
  it('blocks subject rebinding when a candidate user on the same issuer already has a different oidcSubject', async () => {
    const alreadyPinnedUser = {
      id: 77,
      username: 'mario',
      email: 'mario@example.com',
      activated: true,
      oidcIssuer: 'https://idp.example.com',
      oidcSubject: 'original-sub-1',
    };

    let whereCalls = 0;
    const dbMock = {
      select: () => ({
        from: (table: unknown) => ({
          limit: async () =>
            table === settings
              ? [
                  {
                    oidcAutoProvisionUsers: true,
                    oidcLinkExistingUsers: true,
                    oidcSyncOnLogin: false,
                    oidcSyncGroups: false,
                    oidcUsernameClaim: 'preferred_username',
                    oidcGroupsClaim: 'groups',
                    oidcDefaultGroupId: null,
                    oidcDefaultCompanyId: null,
                    oidcGroupMapping: {},
                    locale: 'en-US',
                  },
                ]
              : [],
          where: () => ({
            limit: async () => {
              whereCalls += 1;
              // 1st query: direct (issuer, subject) lookup -> no match
              // 2nd query: username fallback -> returns user already pinned to original-sub-1
              return whereCalls === 2 ? [alreadyPinnedUser] : [];
            },
          }),
        }),
      }),
    } as unknown as ConstructorParameters<typeof OidcUserProvisioningService>[0];

    const svc = new OidcUserProvisioningService(dbMock, makeConfigMock());
    await expect(
      svc.resolveOrProvisionUser({
        iss: 'https://idp.example.com',
        sub: 'attacker-different-sub',
        preferred_username: 'mario',
        email: 'mario@example.com',
        email_verified: true,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('evaluates hasFederatedMfaClaim and enforces 2fa_required in completeUserAuthentication when MFA is absent', async () => {
    expect(AuthService.hasFederatedMfaClaim({})).toBe(false);
    expect(AuthService.hasFederatedMfaClaim({ amr: ['pwd'] })).toBe(false);
    expect(AuthService.hasFederatedMfaClaim({ amr: ['pwd', 'MFA'] })).toBe(true);
    expect(AuthService.hasFederatedMfaClaim({ amr: ['passkey'] })).toBe(true);
    expect(AuthService.hasFederatedMfaClaim({ two_factor_verified: true })).toBe(true);

    const config = makeConfigMock();
    const crypto = new CryptoService(config);
    const jwt = new JwtService(config);

    const dbMock = {
      select: () => ({
        from: () => ({
          limit: async () => [{ twoFactorEnabled: 2 }],
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => undefined,
        }),
      }),
    } as unknown as ConstructorParameters<typeof AuthService>[0];

    const authService = new AuthService(
      dbMock,
      config,
      crypto,
      jwt,
      new OidcUserProvisioningService(dbMock, config),
    );

    vi.spyOn(authService, 'issueSessionForUser').mockResolvedValue({
      status: 'authenticated',
      accessToken: 'acc-mfa',
      refreshToken: 'ref-mfa',
      user: {
        id: 12,
        username: 'mfa-user',
        email: 'mfa@example.com',
        displayName: 'MFA User',
        isSuperUser: false,
        isAdmin: false,
        userCompanyIds: [],
        groupIds: [],
        effectivePermissions: makePermissionsMap([]),
        twoFactorEnrolled: true,
        twoFactorVerified: true,
        authMethod: 'jwt',
      },
    });

    // Without federated MFA claim under global policy REQUIRED -> must demand 2FA challenge
    const challengeRes = await authService.completeUserAuthentication(
      { id: 12, twoFactorEnrolled: true },
      { federatedMfaSatisfied: false },
    );
    expect(challengeRes.status).toBe('2fa_required');
    if (challengeRes.status === '2fa_required') {
      expect(challengeRes.requiresTwoFactor).toBe(true);
      expect(challengeRes.requiresEnrollment).toBe(false);
    }

    // With federated MFA claim satisfied -> issues session directly
    const sessionRes = await authService.completeUserAuthentication(
      { id: 12, twoFactorEnrolled: true },
      { federatedMfaSatisfied: true },
    );
    expect(sessionRes.status).toBe('authenticated');
  });
});

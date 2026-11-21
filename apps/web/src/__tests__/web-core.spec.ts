import '@angular/compiler';
import type { HttpClient } from '@angular/common/http';
import type { Router } from '@angular/router';
import {
  ALL_PERMISSIONS,
  TWO_FACTOR_POLICY,
  type AuthenticatedUserContext,
  type AuthProvidersStatusResponse,
  type PreflightStatusResponse,
} from '@kestrel-it/shared';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { appRoutes } from '../app/app.routes.js';
import { buildAuthHeaders } from '../app/core/auth/auth.interceptor.js';
import { AuthStore } from '../app/core/auth/auth.store.js';
import { evaluateAuthGuard, evaluatePermissionGuard } from '../app/core/guards/auth.guard.js';
import {
  evaluateSetupCompletedGuard,
  evaluateSetupIncompleteGuard,
} from '../app/core/guards/setup.guard.js';
import { filterNavigationItems } from '../app/core/layout/app-shell.component.js';
import { LoginComponent } from '../app/features/auth/login.component.js';
import { SetupWizardComponent } from '../app/features/setup/setup-wizard.component.js';

function makePermissions(grants: string[] = []): AuthenticatedUserContext['effectivePermissions'] {
  const map = {} as AuthenticatedUserContext['effectivePermissions'];
  for (const key of ALL_PERMISSIONS) {
    map[key] = grants.includes(key);
  }
  return map;
}

function makeUser(overrides: Partial<AuthenticatedUserContext> = {}): AuthenticatedUserContext {
  return {
    id: 1,
    username: 'marco',
    email: 'marco@example.com',
    displayName: 'Marco Admin',
    isSuperUser: false,
    isAdmin: false,
    userCompanyIds: [10],
    groupIds: [2],
    effectivePermissions: makePermissions(['assets.view', 'licenses.view']),
    twoFactorEnrolled: false,
    twoFactorVerified: true,
    authMethod: 'jwt',
    ...overrides,
  };
}

describe('AuthStore Signals, RBAC & FMCS', () => {
  it('tracks session state, permission checks, and FMCS company scoping reactively', () => {
    const store = new AuthStore();
    expect(store.isAuthenticated()).toBe(false);
    expect(store.can('assets.view')).toBe(false);

    store.applyLoginResponse({
      status: 'authenticated',
      accessToken: 'jwt-123',
      refreshToken: 'ref-456',
      user: makeUser(),
    });

    expect(store.isAuthenticated()).toBe(true);
    expect(store.displayName()).toBe('Marco Admin');
    expect(store.selectedCompanyId()).toBe(10);
    expect(store.can('assets.view')).toBe(true);
    expect(store.can('assets.delete')).toBe(false);
    expect(store.canAccessCompany(10, true, false)).toBe(true);
    expect(store.canAccessCompany(99, true, false)).toBe(false);

    store.applyLoginResponse({
      status: 'authenticated',
      accessToken: 'jwt-su',
      refreshToken: 'ref-su',
      user: makeUser({ isSuperUser: true, effectivePermissions: makePermissions([]) }),
    });
    expect(store.can('assets.delete')).toBe(true);
    expect(store.canAccessCompany(99, true, false)).toBe(true);

    store.clearSession();
    expect(store.isAuthenticated()).toBe(false);
    expect(store.accessToken()).toBeNull();
  });

  it('builds bearer headers cleanly for HTTP requests', () => {
    expect(buildAuthHeaders(null)).toEqual({});
    expect(buildAuthHeaders('')).toEqual({});
    expect(buildAuthHeaders('token-abc')).toEqual({ Authorization: 'Bearer token-abc' });
  });
});

describe('Setup, Auth & Permission Route Guards + Navigation', () => {
  it('enforces /setup redirect until setupCompleted is true and blocks /setup afterward', () => {
    const store = new AuthStore();
    store.setSetupStatus({
      setupCompleted: false,
      checks: { database: true, storageWritable: true, oidcConfigured: false, smtpConfigured: false },
    });

    expect(evaluateSetupIncompleteGuard(store)).toBe(true);
    expect(evaluateSetupCompletedGuard(store)).toBe('/setup');
    expect(evaluateAuthGuard(store)).toBe('/setup');

    store.setSetupStatus({
      setupCompleted: true,
      checks: { database: true, storageWritable: true, oidcConfigured: true, smtpConfigured: false },
    });

    expect(evaluateSetupIncompleteGuard(store)).toBe('/dashboard');
    expect(evaluateSetupCompletedGuard(store)).toBe(true);
    expect(evaluateAuthGuard(store)).toBe('/login');

    store.applyLoginResponse({
      status: 'authenticated',
      accessToken: 'acc',
      refreshToken: 'ref',
      user: makeUser({ effectivePermissions: makePermissions(['assets.view']) }),
    });

    expect(evaluateAuthGuard(store)).toBe(true);
    expect(evaluatePermissionGuard(store, 'assets.view')).toBe(true);
    expect(evaluatePermissionGuard(store, 'superuser')).toBe('/dashboard');

    const navRoutes = filterNavigationItems(store).map((n) => n.route);
    expect(navRoutes).toContain('/dashboard');
    expect(navRoutes).toContain('/hardware');
    expect(navRoutes).not.toContain('/admin/settings');
  });

  it('defines top-level /setup, /login, and authenticated shell routes', () => {
    const paths = appRoutes.map((r) => r.path);
    expect(paths).toContain('setup');
    expect(paths).toContain('login');
    expect(paths).toContain('');
  });
});

describe('SetupWizardComponent (3-Step Pre-Flight, Instance, Superuser)', () => {
  it('blocks advancing on failed preflight, validates payload with shared schema, and completes setup', async () => {
    const store = new AuthStore();
    const failingStatus: PreflightStatusResponse = {
      setupCompleted: false,
      checks: {
        database: true,
        storageWritable: false,
        oidcConfigured: false,
        smtpConfigured: false,
      },
    };
    const passingStatus: PreflightStatusResponse = {
      setupCompleted: false,
      checks: {
        database: true,
        storageWritable: true,
        oidcConfigured: true,
        smtpConfigured: true,
      },
    };

    let statusCall = 0;
    const httpMock = {
      get: vi.fn(() => {
        statusCall += 1;
        return of(statusCall === 1 ? failingStatus : passingStatus);
      }),
      post: vi.fn(() =>
        of({
          status: 'authenticated' as const,
          accessToken: 'setup-jwt',
          refreshToken: 'setup-ref',
          user: makeUser({ isSuperUser: true, effectivePermissions: makePermissions(['superuser']) }),
        }),
      ),
    } as unknown as HttpClient;

    const routerMock = {
      navigateByUrl: vi.fn(async () => true),
    } as unknown as Router;

    const wizard = new SetupWizardComponent(store, httpMock, routerMock);
    await wizard.loadStatus();

    // Step 1 blocked while storageWritable is false
    expect(wizard.canProceedFromStep1()).toBe(false);
    wizard.goToStep(2);
    expect(wizard.currentStep()).toBe(1);
    expect(wizard.errorMessage()).toContain('Database and writable storage');

    // Refresh checks and advance through all 3 steps
    await wizard.loadStatus();
    expect(wizard.canProceedFromStep1()).toBe(true);
    wizard.goToStep(2);
    expect(wizard.currentStep()).toBe(2);

    wizard.instanceForm.patchValue({
      siteName: 'Acme Kestrel',
      fullMultipleCompaniesSupport: true,
      autoIncrementPrefix: 'ACME-',
    });
    wizard.goToStep(3);
    expect(wizard.currentStep()).toBe(3);

    wizard.adminForm.setValue({
      firstName: 'Ada',
      lastName: 'Lovelace',
      username: 'ada.admin',
      email: 'ada@acme.example.com',
      password: 'VeryStrongPassword123!',
    });

    await wizard.submitSetup();

    expect(httpMock.post).toHaveBeenCalledWith(
      '/api/v1/setup/complete',
      expect.objectContaining({
        siteName: 'Acme Kestrel',
        fullMultipleCompaniesSupport: true,
        username: 'ada.admin',
      }),
    );
    expect(store.isSetupCompleted()).toBe(true);
    expect(store.isAuthenticated()).toBe(true);
    expect(routerMock.navigateByUrl).toHaveBeenCalledWith('/dashboard');
  });
});

describe('LoginComponent (Local + 2FA + SSO Providers)', () => {
  it('loads SSO providers and transitions through 2FA enrollment to authenticated session', async () => {
    const store = new AuthStore();
    const providers: AuthProvidersStatusResponse = {
      local: true,
      twoFactorPolicy: TWO_FACTOR_POLICY.REQUIRED,
      sso: {
        enabled: true,
        protocol: 'oauth2.1',
        loginPath: '/api/v1/auth/oauth/login',
      },
      betterAuth: {
        enabled: true,
        mode: 'federated',
        passkeyEnabled: false,
        providers: ['oidc', 'oauth2.1'],
      },
    };

    const httpMock = {
      get: vi.fn(() => of(providers)),
      post: vi.fn((url: string) => {
        if (url === '/api/v1/auth/login') {
          return of({
            status: '2fa_required' as const,
            requiresTwoFactor: true as const,
            requiresEnrollment: true,
            challengeToken: 'challenge-xyz',
          });
        }
        if (url === '/api/v1/auth/2fa/enroll') {
          return of({
            secret: 'JBSWY3DPEHPK3PXP',
            otpauthUri: 'otpauth://totp/Kestrel-IT:marco?secret=JBSWY3DPEHPK3PXP',
          });
        }
        return of({
          status: 'authenticated' as const,
          accessToken: 'final-jwt',
          refreshToken: 'final-ref',
          user: makeUser({ twoFactorEnrolled: true, twoFactorVerified: true }),
        });
      }),
    } as unknown as HttpClient;

    const routerMock = {
      navigateByUrl: vi.fn(async () => true),
    } as unknown as Router;

    const login = new LoginComponent(store, httpMock, routerMock);
    await login.loadProviders();

    expect(login.ssoEnabled()).toBe(true);
    expect(login.ssoLoginPath()).toBe('/api/v1/auth/oauth/login');
    expect(login.ssoLabel()).toBe('OAuth (OAUTH2.1)');

    login.loginForm.setValue({ username: 'marco', password: 'password123' });
    await login.submitCredentials();

    expect(login.step()).toBe('2fa');
    expect(store.twoFactorChallengeToken()).toBe('challenge-xyz');
    expect(login.totpEnrollment()?.otpauthUri).toContain('otpauth://totp/Kestrel-IT:marco');

    login.totpForm.setValue({ code: '123456' });
    await login.submitTwoFactor();

    expect(store.isAuthenticated()).toBe(true);
    expect(store.accessToken()).toBe('final-jwt');
    expect(routerMock.navigateByUrl).toHaveBeenCalledWith('/dashboard');
  });
});

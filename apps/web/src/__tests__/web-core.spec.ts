import '@angular/compiler';
import type { HttpClient } from '@angular/common/http';
import { convertToParamMap, type ActivatedRoute, type Router } from '@angular/router';
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
import {
  evaluateAuthGuard,
  evaluatePermissionGuard,
  sanitizeRedirectPath,
} from '../app/core/guards/auth.guard.js';
import {
  evaluateSetupCompletedGuard,
  evaluateSetupIncompleteGuard,
} from '../app/core/guards/setup.guard.js';
import { filterNavigationItems, AppShellComponent } from '../app/core/layout/app-shell.component.js';
import { ThemeStore } from '../app/core/theme/theme.store.js';
import { LoginComponent } from '../app/features/auth/login.component.js';
import { SetupWizardComponent } from '../app/features/setup/setup-wizard.component.js';
import {
  DEFAULT_COMMAND_ITEMS,
  KestrelAsyncSelectComponent,
  KestrelCommandPaletteComponent,
  KestrelDataGridComponent,
  KestrelSlideDrawerComponent,
  filterAsyncSelectOptions,
  filterCommandItems,
  resolveAvailableRowActions,
  resolveStatusBadgeConfig,
  sortDataGridRows,
  toggleRowSelectionSet,
  type AsyncSelectOption,
} from '../app/shared/ui/index.js';

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
  it('restores the cookie-backed user before checking dashboard access', async () => {
    const store = new AuthStore();
    const user = makeUser({ userCompanyIds: [12] });
    const http = {
      get: vi.fn((url: string) => of(
        url.endsWith('/setup/status') ? { setupCompleted: true } : user,
      )),
    } as unknown as HttpClient;

    await store.initialize(http);
    expect(store.accessToken()).toBeNull();
    expect(store.currentUser()).toEqual(user);
    expect(store.selectedCompanyId()).toBe(12);
    expect(evaluateAuthGuard(store)).toBe(true);
  });

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
    expect(evaluateAuthGuard(store, '/hardware/audit/due-or-overdue')).toBe(
      '/login?redirect=%2Fhardware%2Faudit%2Fdue-or-overdue',
    );
    expect(evaluateAuthGuard(store, '/dashboard')).toBe('/login');
    expect(sanitizeRedirectPath('/hardware/audit/due-or-overdue?search=TAG-1')).toBe(
      '/hardware/audit/due-or-overdue?search=TAG-1',
    );
    expect(sanitizeRedirectPath('https://evil.example/phish')).toBe('/dashboard');
    expect(sanitizeRedirectPath('//evil.example/phish')).toBe('/dashboard');
    expect(sanitizeRedirectPath('/\\evil.example')).toBe('/dashboard');
    expect(sanitizeRedirectPath('/login?redirect=/hardware')).toBe('/dashboard');

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
    expect(wizard.ngOnInit()).toBeUndefined();
    await vi.waitFor(() => expect(wizard.preflight()).toEqual(failingStatus));

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
  it('starts the SSO challenge from a synchronous Angular lifecycle hook', async () => {
    const store = new AuthStore();
    const route = {
      snapshot: { queryParamMap: convertToParamMap({ sso: 'challenge' }) },
    } as ActivatedRoute;
    const get = vi.fn(() =>
      of({
        status: '2fa_required',
        requiresTwoFactor: true,
        requiresEnrollment: false,
        challengeToken: 'challenge-xyz',
      }),
    );
    const http = { get } as unknown as HttpClient;
    const login = new LoginComponent(store, http, undefined, undefined, route);

    expect(login.ngOnInit()).toBeUndefined();
    await vi.waitFor(() => expect(login.step()).toBe('2fa'));
    expect(store.twoFactorChallengeToken()).toBe('challenge-xyz');
    expect(get.mock.calls).toEqual([['/api/v1/auth/sso/challenge']]);
  });

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
    expect(login.ngOnInit()).toBeUndefined();
    await vi.waitFor(() => expect(login.ssoEnabled()).toBe(true));
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

  it('redirects back to a safe requested destination after credential and 2FA login', async () => {
    const store = new AuthStore();
    const routerMock = {
      navigateByUrl: vi.fn(async () => true),
    } as unknown as Router;
    const targetRoute = {
      snapshot: {
        queryParamMap: convertToParamMap({ redirect: '/hardware/audit/due-or-overdue' }),
      },
    } as ActivatedRoute;
    const directHttp = {
      post: vi.fn(() =>
        of({
          status: 'authenticated' as const,
          accessToken: 'direct-jwt',
          refreshToken: 'direct-ref',
          user: makeUser(),
        }),
      ),
    } as unknown as HttpClient;

    const directLogin = new LoginComponent(store, directHttp, routerMock, undefined, targetRoute);
    expect(directLogin.ssoLoginPath()).toBe(
      '/api/v1/auth/oidc/login?redirect=%2Fhardware%2Faudit%2Fdue-or-overdue',
    );
    directLogin.loginForm.setValue({ username: 'marco', password: 'password123' });
    await directLogin.submitCredentials();
    expect(routerMock.navigateByUrl).toHaveBeenLastCalledWith('/hardware/audit/due-or-overdue');

    const twoFactorHttp = {
      post: vi.fn((url: string) =>
        of(
          url === '/api/v1/auth/login'
            ? {
                status: '2fa_required' as const,
                requiresTwoFactor: true as const,
                requiresEnrollment: false,
                challengeToken: 'challenge-redirect',
              }
            : {
                status: 'authenticated' as const,
                accessToken: '2fa-jwt',
                refreshToken: '2fa-ref',
                user: makeUser({ twoFactorEnrolled: true, twoFactorVerified: true }),
              },
        ),
      ),
    } as unknown as HttpClient;
    const twoFactorLogin = new LoginComponent(store, twoFactorHttp, routerMock, undefined, targetRoute);
    twoFactorLogin.loginForm.setValue({ username: 'marco', password: 'password123' });
    await twoFactorLogin.submitCredentials();
    twoFactorLogin.totpForm.setValue({ code: '654321' });
    await twoFactorLogin.submitTwoFactor();
    expect(routerMock.navigateByUrl).toHaveBeenLastCalledWith('/hardware/audit/due-or-overdue');

    const unsafeRoute = {
      snapshot: { queryParamMap: convertToParamMap({ redirect: '//evil.example/phish' }) },
    } as ActivatedRoute;
    const unsafeLogin = new LoginComponent(store, directHttp, routerMock, undefined, unsafeRoute);
    expect(unsafeLogin.ssoLoginPath()).toBe('/api/v1/auth/oidc/login');
    unsafeLogin.loginForm.setValue({ username: 'marco', password: 'password123' });
    await unsafeLogin.submitCredentials();
    expect(routerMock.navigateByUrl).toHaveBeenLastCalledWith('/dashboard');
  });
});

describe('ThemeStore & Shared UI Kit (Piano 1.7 Precision Enterprise)', () => {
  it('manages Light/Dark/System themes cleanly in ThemeStore', () => {
    const themeStore = new ThemeStore();
    expect(themeStore.mode()).toBe('light');
    expect(themeStore.resolvedTheme()).toBe('light');
    expect(themeStore.isDark()).toBe(false);

    themeStore.toggleTheme();
    expect(themeStore.mode()).toBe('dark');
    expect(themeStore.resolvedTheme()).toBe('dark');
    expect(themeStore.isDark()).toBe(true);

    themeStore.setMode('system');
    themeStore.systemPrefersDark.set(false);
    expect(themeStore.resolvedTheme()).toBe('light');
    themeStore.systemPrefersDark.set(true);
    expect(themeStore.resolvedTheme()).toBe('dark');
  });

  it('maps Snipe-IT status meta types accurately in StatusBadge', () => {
    expect(resolveStatusBadgeConfig('deployable')).toMatchObject({
      tone: 'deployable',
      label: 'Ready to Deploy',
    });
    expect(resolveStatusBadgeConfig('deployed', 'Assigned to Alice')).toMatchObject({
      tone: 'deployed',
      label: 'Assigned to Alice',
    });
    expect(resolveStatusBadgeConfig('pending')).toMatchObject({ tone: 'pending', label: 'Pending' });
    expect(resolveStatusBadgeConfig('undeployable')).toMatchObject({
      tone: 'undeployable',
      label: 'Undeployable',
    });
    expect(resolveStatusBadgeConfig('archived')).toMatchObject({ tone: 'archived', label: 'Archived' });
  });

  it('handles sorting, bulk selection, search, and available_actions in KestrelDataGridComponent', () => {
    expect(
      resolveAvailableRowActions({ checkout: true, checkin: false, update: true, delete: false }),
    ).toEqual(['checkout', 'update']);

    const unsorted = [
      { id: 2, tag: 'KST-002', cost: 200 },
      { id: 1, tag: 'KST-001', cost: 1500 },
    ];
    expect(sortDataGridRows(unsorted, 'cost', 'asc').map((r) => r.id)).toEqual([2, 1]);
    expect(sortDataGridRows(unsorted, 'tag', 'desc').map((r) => r.id)).toEqual([2, 1]);

    let selected = toggleRowSelectionSet(new Set(), 1);
    expect([...selected]).toEqual([1]);
    selected = toggleRowSelectionSet(selected, 1);
    expect([...selected]).toEqual([]);

    const grid = new KestrelDataGridComponent();
    grid.serverSide = false;
    grid.columns = [
      { key: 'asset_tag', label: 'Tag', type: 'mono' },
      { key: 'name', label: 'Name', type: 'text' },
    ];
    grid.rows = [
      { id: 10, asset_tag: 'KST-010', name: 'Laptop Beta', available_actions: { checkout: true } },
      { id: 20, asset_tag: 'KST-002', name: 'Laptop Alpha', available_actions: { checkin: true } },
    ];

    const sortSpy = vi.fn();
    grid.sortChanged.subscribe(sortSpy);
    grid.toggleSort({ key: 'asset_tag', label: 'Tag' });
    expect(sortSpy).toHaveBeenCalledWith({ sort: 'asset_tag', order: 'asc' });
    expect(grid.displayedRows().map((r) => r['id'])).toEqual([20, 10]);

    grid.toggleSelectAll();
    expect([...grid.selectedIds()]).toEqual([20, 10]);
    grid.toggleRowSelection(20);
    expect([...grid.selectedIds()]).toEqual([10]);

    grid.serverSide = true;
    grid.onSearchInput('value searchable only on the server');
    expect(grid.displayedRows().map((r) => r['id'])).toEqual([10, 20]);
  });

  it('treats structured data grid cell values as unavailable', () => {
    const grid = new KestrelDataGridComponent();
    const column = { key: 'value', label: 'Value' };
    const structured = { id: 1, value: { name: 'Laptop' } };
    const scalar = { id: 2, value: 42 };
    grid.serverSide = false;
    grid.columns = [column];
    grid.rows = [structured, scalar];

    expect(grid.formatCell(structured, column)).toBe('—');
    expect(grid.formatCell(scalar, column)).toBe('42');
    expect(sortDataGridRows(grid.rowsSignal(), column.key, 'asc')).toEqual([scalar, structured]);
    expect(sortDataGridRows(grid.rowsSignal(), column.key, 'desc')).toEqual([scalar, structured]);

    grid.onSearchInput('[object Object]');
    expect(grid.displayedRows()).toEqual([]);
    grid.onSearchInput('42');
    expect(grid.displayedRows()).toEqual([scalar]);
  });

  it('reconciles AsyncSelect values after direct scope and options assignments', async () => {
    const options: AsyncSelectOption[] = [
      { id: 1, text: 'Milan HQ', companyId: 10 },
      { id: 2, text: 'Rome Ops', companyId: 20 },
      { id: 3, text: 'Global Remote Pool', companyId: null },
    ];

    expect(filterAsyncSelectOptions(options, '', 10, true).map((o) => o.id)).toEqual([1, 3]);
    expect(filterAsyncSelectOptions(options, 'milan', 10, false).map((o) => o.id)).toEqual([1]);

    const select = new KestrelAsyncSelectComponent();
    select.options = options;
    select.companyId = 10;
    select.selectOption(options[0]!);
    expect(select.selectedId()).toBe(1);

    // Switching company scope to 20 must invalidate option id 1 (belongs to company 10)
    select.companyId = 20;
    await Promise.resolve();
    expect(select.selectedId()).toBeNull();
    expect(select.filteredOptions().map((o) => o.id)).toEqual([2, 3]);

    const quickSpy = vi.fn();
    select.quickCreate.subscribe(quickSpy);
    select.onSearchChange('Turin DC');
    select.triggerQuickCreate();
    expect(quickSpy).toHaveBeenCalledWith({ query: 'Turin DC', companyId: 20 });

    select.writeValue(3);
    select.includeNullCompany = false;
    await Promise.resolve();
    expect(select.selectedId()).toBeNull();

    select.options = [];
    select.writeValue(1);
    select.companyId = 10;
    await Promise.resolve();
    expect(select.selectedId()).toBe(1);
    select.options = options;
    await Promise.resolve();
    expect(select.selectedOption()?.text).toBe('Milan HQ');

    select.companyId = 30;
    select.options = [{ id: 1, text: 'Berlin HQ', companyId: 30 }];
    await Promise.resolve();
    expect(select.selectedId()).toBe(1);
    expect(select.selectedOption()?.text).toBe('Berlin HQ');
  });

  it('filters CommandPalette items by query & RBAC permissions and integrates with AppShellComponent + SlideDrawer', () => {
    const authStore = new AuthStore();
    authStore.applyLoginResponse({
      status: 'authenticated',
      accessToken: 'jwt',
      refreshToken: 'ref',
      user: makeUser({ effectivePermissions: makePermissions(['assets.view']) }),
    });

    const permitted = filterCommandItems(DEFAULT_COMMAND_ITEMS, '', authStore);
    expect(permitted.some((i) => i.route === '/hardware')).toBe(true);
    expect(permitted.some((i) => i.route === '/admin/settings')).toBe(false);

    const searchMatches = filterCommandItems(DEFAULT_COMMAND_ITEMS, 'dark', authStore);
    expect(searchMatches.map((i) => i.id)).toEqual(['theme-toggle']);

    const themeStore = new ThemeStore();
    const routerMock = { navigateByUrl: vi.fn(async () => true) } as unknown as Router;
    const palette = new KestrelCommandPaletteComponent(authStore, themeStore, routerMock);
    palette.openPalette();
    expect(palette.isOpen()).toBe(true);
    palette.executeItem(searchMatches[0]!);
    expect(themeStore.isDark()).toBe(true);
    expect(palette.isOpen()).toBe(false);

    const drawer = new KestrelSlideDrawerComponent();
    const closedSpy = vi.fn();
    drawer.closed.subscribe(closedSpy);
    drawer.open = true;
    drawer.onKeydown({ key: 'Escape' } as KeyboardEvent);
    expect(closedSpy).toHaveBeenCalledTimes(1);

    const shell = new AppShellComponent(authStore, themeStore, undefined, routerMock);
    expect(shell.sidebarCollapsed()).toBe(false);
    shell.toggleSidebar();
    expect(shell.sidebarCollapsed()).toBe(true);
    shell.openCommandPalette();
    expect(shell.commandPaletteOpen()).toBe(true);
    shell.toggleTheme();
    expect(themeStore.isDark()).toBe(false);
  });
});

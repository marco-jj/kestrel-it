import '@angular/compiler';
import { HttpClient, HttpErrorResponse, HttpRequest, HttpResponse } from '@angular/common/http';
import { ElementRef, Injector, runInInjectionContext } from '@angular/core';
import { FormControl } from '@angular/forms';
import { convertToParamMap, type ActivatedRoute, type Router } from '@angular/router';
import {
  ALL_PERMISSIONS,
  TWO_FACTOR_POLICY,
  type AuthenticatedUserContext,
  type AuthProvidersStatusResponse,
  type PreflightStatusResponse,
} from '@kestrel-it/shared';
import { firstValueFrom, of, Subject, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { appRoutes } from '../app/app.routes.js';
import { authInterceptor, buildAuthHeaders } from '../app/core/auth/auth.interceptor.js';
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
import { DashboardComponent } from '../app/features/dashboard/dashboard.component.js';
import { LoginComponent } from '../app/features/auth/login.component.js';
import { SetupWizardComponent } from '../app/features/setup/setup-wizard.component.js';
import { DIRECTORY_UI, directoryFormField, field } from '../app/features/inventory/directory-ui.js';
import { assignmentRecipient } from '../app/features/inventory/phase-three-page.component.js';
import { inventoryFieldValidators } from '../app/features/inventory/inventory-field-validation.js';
import { AssetTagFieldComponent, suggestAssetTags } from '../app/features/inventory/asset-tag-field.component.js';
import { InventoryApi } from '../app/features/inventory/inventory-api.js';
import { fieldValidationMessage } from '../app/shared/ui/field-validation.js';
import { DateInputComponent } from '../app/shared/ui/date-input.component.js';
import { formatDisplayDate, parseDisplayDate } from '../app/shared/ui/display-date.js';
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

describe('Inventory field and table regressions', () => {
  it('requires a password when creating a local user and leaves an existing password optional', () => {
    const password = DIRECTORY_UI.users.fields.find(({ key }) => key === 'password')!;
    const creating = directoryFormField(password, 'users', false);
    const control = new FormControl<string | null>(null, inventoryFieldValidators(creating));
    expect(control.invalid).toBe(true);
    expect(fieldValidationMessage(control, creating.label)).toBe('Password is required.');
    control.setValue('correct-password');
    expect(control.valid).toBe(true);
    const editing = directoryFormField(password, 'users', true);
    expect(new FormControl('', inventoryFieldValidators(editing)).valid).toBe(true);
  });

  it('dismisses the centered confirmation on Escape only while it is open', () => {
    const confirmation = new KestrelSlideDrawerComponent();
    confirmation.placement = 'center';
    const closed = vi.fn();
    confirmation.closed.subscribe(closed);
    confirmation.onKeydown({ key: 'Escape' } as KeyboardEvent);
    expect(closed).not.toHaveBeenCalled();
    confirmation.open = true;
    confirmation.onKeydown({ key: 'Escape' } as KeyboardEvent);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('uses the readable seat recipient and supports API responses without a label', () => {
    expect(assignmentRecipient({ assigned_to: 1, assigned_to_label: 'Ada Lovelace' })).toBe('Ada Lovelace');
    expect(assignmentRecipient({ assigned_to: 1, assigned_to_label: 'ada@example.test' })).toBe('ada@example.test');
    expect(assignmentRecipient({ assigned_to: 1 })).toBe('User #1');
    expect(assignmentRecipient({ occupied: true })).toBe('');
  });
  it('dismisses empty and populated select menus outside the component and resets the query', () => {
    const host = {};
    const select = new KestrelAsyncSelectComponent(new ElementRef(host as HTMLElement));
    const pointer = (path: unknown[]) => ({ composedPath: () => path }) as PointerEvent;
    select.options = [{ id: 1, text: 'London' }];
    select.writeValue(1);
    select.onSearchChange('missing');
    expect(select.filteredOptions()).toEqual([]);
    select.onDocumentPointerDown(pointer([host]));
    expect(select.isOpen()).toBe(true);
    select.onDocumentPointerDown(pointer([]));
    expect(select.isOpen()).toBe(false);
    expect(select.displayInputValue()).toBe('London');
    select.openDropdown();
    expect(select.filteredOptions()).toHaveLength(1);
    select.onDocumentPointerDown(pointer([]));
    expect(select.isOpen()).toBe(false);
  });

  it('formats expiry dates in day/month/year order and keeps empty values readable', () => {
    const grid = new KestrelDataGridComponent();
    const expiry = { key: 'expires', label: 'Expires', type: 'date' as const };
    expect(grid.formatCell({ expires: '2026-11-25' }, expiry)).toBe('25/11/2026');
    expect(grid.formatCell({ expires: '2026-11-25T00:01:00+02:00' }, expiry)).toBe('25/11/2026');
    expect(grid.formatCell({}, expiry)).toBe('—');
  });

  it('formats inventory dates and timestamps without changing ISO-looking identifiers', () => {
    const grid = new KestrelDataGridComponent();
    expect(formatDisplayDate({ date: '2026-12-11', formatted: '2026-12-11' })).toBe('11/12/2026');
    expect(formatDisplayDate({ datetime: '2026-11-26 09:14:27' }, true)).toBe('26/11/2026 09:14:27');
    expect(formatDisplayDate('2026-11-11T00:05:00+02:00')).toBe('11/11/2026');
    expect(grid.formatCell({ purchase_date: '2026-11-11' }, { key: 'purchase_date', label: 'Purchased' })).toBe('11/11/2026');
    expect(grid.formatCell({ serial: '2026-11-11' }, { key: 'serial', label: 'Serial' })).toBe('2026-11-11');
  });

  it('accepts display dates in edit controls and emits calendar dates and times in ISO form', () => {
    const input = new DateInputComponent();
    const changed = vi.fn();
    input.registerOnChange(changed);
    input.writeValue('2026-12-11');
    expect(input.text()).toBe('11/12/2026');
    input.edit('31/02/2026');
    expect(input.validate()).toEqual({ dateFormat: true });
    input.edit('29/02/2028');
    expect(input.validate()).toBeNull();
    expect(changed).toHaveBeenLastCalledWith('2028-02-29');
    input.choose('2026-11-11');
    expect(input.text()).toBe('11/11/2026');
    expect(changed).toHaveBeenLastCalledWith('2026-11-11');
    expect(parseDisplayDate('26/11/2026 09:14:27', true)).toBe('2026-11-26T09:14:27');
    expect(parseDisplayDate('26/11/2026 24:00', true)).toBeNull();
  });

  it('updates phone, email and URL validation messages as the value changes', () => {
    for (const [type, invalid, valid] of [
      ['tel', '12+3', '+3908123456'],
      ['email', 'missing-domain', 'operator@example.test'],
      ['url', 'example.test', 'https://example.test'],
    ] as const) {
      const control = new FormControl('', inventoryFieldValidators(field(type, type, type)));
      control.markAsDirty();
      control.setValue(invalid);
      expect(fieldValidationMessage(control)).toBeTruthy();
      control.setValue(valid);
      expect(control.valid).toBe(true);
      expect(fieldValidationMessage(control)).toBeNull();
    }
  });

  it('shows the same password limit in user creation and setup before submit', () => {
    const password = DIRECTORY_UI.users.fields.find(({ key }) => key === 'password')!;
    const setup = new SetupWizardComponent(new AuthStore());
    const userPassword = new FormControl('', inventoryFieldValidators(password));
    expect(userPassword.valid).toBe(true);
    for (const control of [userPassword, setup.adminForm.controls.password]) {
      control.markAsDirty();
      control.setValue('123456789');
      expect(fieldValidationMessage(control)).toBe('Use at least 10 characters.');
      control.setValue('1234567890');
      expect(fieldValidationMessage(control)).toBeNull();
    }
  });

  it('validates the configured phone field in the user form as it changes', () => {
    const phone = DIRECTORY_UI.users.fields.find(({ key }) => key === 'phone')!;
    const control = new FormControl('', inventoryFieldValidators(phone));
    expect(phone.type).toBe('tel');
    control.markAsDirty();
    control.setValue('ff3');
    expect(fieldValidationMessage(control)).toBe('Enter digits with an optional leading +.');
    control.setValue('+3908123456');
    expect(fieldValidationMessage(control)).toBeNull();
  });

  it('commits an asset tag as a single removable value and suggests unique matching tags', () => {
    const injector = Injector.create({ providers: [
      { provide: ElementRef, useValue: new ElementRef({}) },
      { provide: InventoryApi, useValue: {} },
    ] });
    const editor = runInInjectionContext(injector, () => new AssetTagFieldComponent());
    const changed = vi.fn();
    editor.registerOnChange(changed);
    editor.edit(' kst ');
    editor.commit('KST-42');
    expect(editor.committed()).toBe(true);
    expect(changed).toHaveBeenLastCalledWith('KST-42');
    editor.remove();
    expect(editor.committed()).toBe(false);
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(suggestAssetTags([
      { asset_tag: 'KST-42' }, { asset_tag: 'KST-42' }, { asset_tag: 'other' }, {},
    ], 'kst')).toEqual(['KST-42']);
  });

  it('renders saved status colors including hex values without the prefix', () => {
    const grid = new KestrelDataGridComponent();
    expect(grid.colorSwatch('#2f6d78')).toBe('#2f6d78');
    expect(grid.colorSwatch('2f6d78')).toBe('#2f6d78');
    expect(grid.colorSwatch('')).toBeNull();
  });
});

describe('AuthStore Signals, RBAC & FMCS', () => {
  it('rotates both tokens once for concurrent 401s and retries the original requests', async () => {
    const store = new AuthStore();
    const initial = {
      status: 'authenticated' as const, accessToken: 'access-old', refreshToken: 'refresh-old', user: makeUser(),
    };
    store.applyLoginResponse(initial);
    const response = new Subject<typeof initial>();
    const post = vi.fn(() => response);
    const injector = Injector.create({ providers: [
      { provide: AuthStore, useValue: store },
      { provide: HttpClient, useValue: { post } },
    ] });
    const unauthorized = new HttpErrorResponse({
      status: 401, error: { message: 'Invalid or expired token' },
    });
    const next = vi.fn((request: HttpRequest<unknown>) =>
      request.headers.get('Authorization') === 'Bearer access-new'
        ? of(new HttpResponse({ body: request.body }))
        : throwError(() => unauthorized),
    );
    const mutation = new HttpRequest('POST', '/api/v1/users', { username: 'test' });
    const read = new HttpRequest('GET', '/api/v1/users');
    const result = Promise.all(
      [mutation, read].map((request) => runInInjectionContext(injector, () =>
        firstValueFrom(authInterceptor(request, next)),
      )),
    );
    expect(post).toHaveBeenCalledExactlyOnceWith('/api/v1/auth/refresh', {});
    response.next({ ...initial, accessToken: 'access-new', refreshToken: 'refresh-new' });
    await result;
    expect(store.refreshToken()).toBe('refresh-new');
    expect(next.mock.calls.map(([request]) => [
      request.method, request.body, request.headers.get('Authorization'),
    ])).toEqual([
      ['POST', mutation.body, 'Bearer access-old'],
      ['GET', null, 'Bearer access-old'],
      ['POST', mutation.body, 'Bearer access-new'],
      ['GET', null, 'Bearer access-new'],
    ]);
  });

  it('does not loop on a rejected refresh or retry login failures', async () => {
    const store = new AuthStore();
    store.applyLoginResponse({
      status: 'authenticated', accessToken: 'access', refreshToken: 'refresh', user: makeUser(),
    });
    const error = new HttpErrorResponse({ status: 401, error: { message: 'Invalid or expired token' } });
    const post = vi.fn(() => throwError(() => error));
    const next = vi.fn(() => throwError(() => error));
    const injector = Injector.create({ providers: [
      { provide: AuthStore, useValue: store },
      { provide: HttpClient, useValue: { post } },
    ] });
    const request = (url: string) => runInInjectionContext(injector, () =>
      firstValueFrom(authInterceptor(new HttpRequest('POST', url, {}), next)),
    );
    await expect(request('/api/v1/auth/login')).rejects.toBe(error);
    expect(post).not.toHaveBeenCalled();
    await expect(request('/api/v1/users')).rejects.toBe(error);
    expect(post).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(2);
    expect(store.isAuthenticated()).toBe(false);
  });
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
    expect(sanitizeRedirectPath('/settings/..//network-path')).toBe('/dashboard');

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
          status: 'success' as const,
          messages: 'Setup completed successfully.',
          payload: {
            status: 'authenticated' as const,
            accessToken: 'setup-jwt',
            refreshToken: 'setup-ref',
            user: makeUser({
              isSuperUser: true,
              effectivePermissions: makePermissions(['superuser']),
            }),
          },
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

  it('registers self-service, admin, and hardware quick-action routes cleanly before :id', () => {
    const shellChildren = appRoutes.find((r) => r.path === '')?.children ?? [];
    const childPaths = shellChildren.map((r) => r.path);

    for (const expected of [
      'hardware/create',
      'hardware/bulk-checkout',
      'hardware/:id',
      'account/profile',
      'account/view-assets',
      'account/api',
      'admin/settings',
      'admin/branding',
      'admin/integrations',
      'admin/login-attempts',
    ]) {
      expect(childPaths).toContain(expected);
    }

    expect(childPaths.indexOf('hardware/create')).toBeLessThan(childPaths.indexOf('hardware/:id'));
    expect(childPaths.indexOf('hardware/bulk-checkout')).toBeLessThan(
      childPaths.indexOf('hardware/:id'),
    );

    const limitedStore = new AuthStore();
    const limitedPerms = makePermissions(['assets.view', 'self.api']);
    limitedStore.applyLoginResponse({
      status: 'authenticated',
      accessToken: 'jwt',
      refreshToken: 'ref',
      user: makeUser({
        effectivePermissions: limitedPerms,
        keyPermissions: limitedPerms,
      }),
    });

    const visibleRoutes = filterNavigationItems(limitedStore).map((n) => n.route);
    expect(visibleRoutes).toContain('/account/profile');
    expect(visibleRoutes).toContain('/account/view-assets');
    expect(visibleRoutes).toContain('/account/api');
    expect(visibleRoutes).not.toContain('/admin/branding');
    expect(visibleRoutes).not.toContain('/admin/login-attempts');

    const cmdRoutes = filterCommandItems(DEFAULT_COMMAND_ITEMS, '', limitedStore).map((c) => c.route);
    expect(cmdRoutes).toContain('/account/api');
    expect(cmdRoutes).not.toContain('/admin/login-attempts');

    const dashboard = new DashboardComponent(limitedStore);
    expect(dashboard.activeCompanyCount()).toBe('1');
    expect(dashboard.statusSummaryLine()).toBe('Live telemetry');
  });
});

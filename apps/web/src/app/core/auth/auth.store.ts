import { HttpErrorResponse, type HttpClient } from '@angular/common/http';
import { Injectable, computed, signal } from '@angular/core';
import {
  CHECKOUT_REQUEST_PERMISSIONS,
  canAccessCompanyRecord,
  type AuthenticatedUserContext,
  type AuthProvidersStatusResponse,
  type LoginResponse,
  type PermissionKey,
  type PreflightStatusResponse,
} from '@kestrel-it/shared';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class AuthStore {
  readonly currentUser = signal<AuthenticatedUserContext | null>(null);
  readonly accessToken = signal<string | null>(null);
  readonly refreshToken = signal<string | null>(null);
  readonly setupStatus = signal<PreflightStatusResponse | null>(null);
  readonly providersStatus = signal<AuthProvidersStatusResponse | null>(null);
  readonly selectedCompanyId = signal<number | null>(null);
  readonly twoFactorChallengeToken = signal<string | null>(null);
  readonly requiresTwoFactorEnrollment = signal<boolean>(false);
  private pendingRefresh?: Promise<string | null>;
  private sessionVersion = 0;

  get sessionGeneration(): number {
    return this.sessionVersion;
  }

  readonly isAuthenticated = computed(() => this.currentUser() !== null);
  readonly isSetupCompleted = computed(() => this.setupStatus()?.setupCompleted ?? false);
  readonly isSuperUser = computed(() => this.currentUser()?.isSuperUser ?? false);
  readonly isAdmin = computed(() => this.currentUser()?.isAdmin ?? false);
  readonly canManageCheckoutRequests = computed(() => {
    const user = this.currentUser();
    if (!user) return false;
    return user.isSuperUser || Object.values(CHECKOUT_REQUEST_PERMISSIONS).some(
      (permission) => user.keyPermissions?.[permission] === true,
    );
  });
  readonly userCompanyIds = computed(() => this.currentUser()?.userCompanyIds ?? []);
  readonly displayName = computed(() => {
    const user = this.currentUser();
    return user ? user.displayName || user.username : '';
  });

  async initialize(http: HttpClient): Promise<void> {
    try {
      this.setSetupStatus(await firstValueFrom(
        http.get<PreflightStatusResponse>('/api/v1/setup/status'),
      ));
    } catch {
      return; // The setup page can display preflight failure and retry.
    }
    if (!this.isSetupCompleted()) return;

    try {
      this.setSessionUser(await firstValueFrom(
        http.get<AuthenticatedUserContext>('/api/v1/auth/me'),
      ));
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        await this.refreshSession(http);
      }
    }
  }

  refreshSession(http: HttpClient): Promise<string | null> {
    if (this.pendingRefresh) return this.pendingRefresh;

    const version = this.sessionVersion;
    const refresh = firstValueFrom(http.post<LoginResponse>('/api/v1/auth/refresh', {}))
      .then((response) => {
        if (version !== this.sessionVersion || response.status !== 'authenticated') return null;
        this.setAuthenticatedSession(response);
        return response.accessToken;
      })
      .catch((error: unknown) => {
        if (version === this.sessionVersion && error instanceof HttpErrorResponse && error.status === 401) {
          this.clearSession();
        }
        return null;
      })
      .finally(() => {
        if (this.pendingRefresh === refresh) this.pendingRefresh = undefined;
      });
    this.pendingRefresh = refresh;
    return refresh;
  }

  applyLoginResponse(response: LoginResponse): void {
    this.sessionVersion++;
    this.pendingRefresh = undefined;
    if (response.status === '2fa_required') {
      this.twoFactorChallengeToken.set(response.challengeToken);
      this.requiresTwoFactorEnrollment.set(response.requiresEnrollment);
      this.currentUser.set(null);
      this.accessToken.set(null);
      this.refreshToken.set(null);
      return;
    }

    this.setAuthenticatedSession(response);
  }

  private setAuthenticatedSession(response: Extract<LoginResponse, { status: 'authenticated' }>): void {
    this.twoFactorChallengeToken.set(null);
    this.requiresTwoFactorEnrollment.set(false);
    this.setSessionUser(response.user);
    this.accessToken.set(response.accessToken);
    this.refreshToken.set(response.refreshToken);
  }

  private setSessionUser(user: AuthenticatedUserContext): void {
    this.currentUser.set(user);
    const companies = user.userCompanyIds;
    const currentCompany = this.selectedCompanyId();
    if (currentCompany === null || !companies.includes(currentCompany)) {
      this.selectedCompanyId.set(companies[0] ?? null);
    }
  }

  clearSession(): void {
    this.sessionVersion++;
    this.pendingRefresh = undefined;
    this.currentUser.set(null);
    this.accessToken.set(null);
    this.refreshToken.set(null);
    this.twoFactorChallengeToken.set(null);
    this.requiresTwoFactorEnrollment.set(false);
    this.selectedCompanyId.set(null);
  }

  setSetupStatus(status: PreflightStatusResponse): void {
    this.setupStatus.set(status);
  }

  setProvidersStatus(status: AuthProvidersStatusResponse): void {
    this.providersStatus.set(status);
  }

  setSelectedCompanyId(companyId: number | null): void {
    this.selectedCompanyId.set(companyId);
  }

  can(permission: PermissionKey): boolean {
    const user = this.currentUser();
    if (!user) {
      return false;
    }
    if (user.isSuperUser) {
      return true;
    }
    return user.effectivePermissions[permission] === true;
  }

  canAccessCompany(
    recordCompanyId: number | null | undefined,
    fmcsEnabled = false,
    nullCompanyIsFloater = true,
  ): boolean {
    const user = this.currentUser();
    if (!user) {
      return false;
    }
    return canAccessCompanyRecord({
      fmcsEnabled,
      nullCompanyIsFloater,
      isSuperUser: user.isSuperUser,
      userCompanyIds: user.userCompanyIds,
      targetCompanyId: recordCompanyId,
    });
  }
}

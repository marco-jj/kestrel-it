import { Injectable, computed, signal } from '@angular/core';
import {
  canAccessCompanyRecord,
  type AuthenticatedUserContext,
  type AuthProvidersStatusResponse,
  type LoginResponse,
  type PermissionKey,
  type PreflightStatusResponse,
} from '@kestrel-it/shared';

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

  readonly isAuthenticated = computed(() => this.currentUser() !== null && this.accessToken() !== null);
  readonly isSetupCompleted = computed(() => this.setupStatus()?.setupCompleted ?? false);
  readonly isSuperUser = computed(() => this.currentUser()?.isSuperUser ?? false);
  readonly isAdmin = computed(() => this.currentUser()?.isAdmin ?? false);
  readonly userCompanyIds = computed(() => this.currentUser()?.userCompanyIds ?? []);
  readonly displayName = computed(() => {
    const user = this.currentUser();
    return user ? user.displayName || user.username : '';
  });

  applyLoginResponse(response: LoginResponse): void {
    if (response.status === '2fa_required') {
      this.twoFactorChallengeToken.set(response.challengeToken);
      this.requiresTwoFactorEnrollment.set(response.requiresEnrollment);
      this.currentUser.set(null);
      this.accessToken.set(null);
      this.refreshToken.set(null);
      return;
    }

    this.twoFactorChallengeToken.set(null);
    this.requiresTwoFactorEnrollment.set(false);
    this.currentUser.set(response.user);
    this.accessToken.set(response.accessToken);
    this.refreshToken.set(response.refreshToken);

    const companies = response.user.userCompanyIds;
    if (companies.length > 0 && this.selectedCompanyId() === null) {
      this.selectedCompanyId.set(companies[0] ?? null);
    }
  }

  clearSession(): void {
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

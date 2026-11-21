import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import type { PermissionKey } from '@kestrel-it/shared';
import { AuthStore } from '../auth/auth.store.js';

export function evaluateAuthGuard(store: AuthStore): true | string {
  if (!store.isSetupCompleted()) {
    return '/setup';
  }
  if (!store.isAuthenticated()) {
    return '/login';
  }
  return true;
}

export function evaluatePermissionGuard(
  store: AuthStore,
  permission: PermissionKey,
): true | string {
  const authResult = evaluateAuthGuard(store);
  if (authResult !== true) {
    return authResult;
  }
  return store.can(permission) ? true : '/dashboard';
}

export const authGuard: CanActivateFn = () => {
  const store = inject(AuthStore);
  const router = inject(Router);
  const decision = evaluateAuthGuard(store);
  return decision === true ? true : router.parseUrl(decision);
};

export function createPermissionGuard(permission: PermissionKey): CanActivateFn {
  return () => {
    const store = inject(AuthStore);
    const router = inject(Router);
    const decision = evaluatePermissionGuard(store, permission);
    return decision === true ? true : router.parseUrl(decision);
  };
}

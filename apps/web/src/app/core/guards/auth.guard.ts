import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import type { PermissionKey } from '@kestrel-it/shared';
import { AuthStore } from '../auth/auth.store.js';

export function sanitizeRedirectPath(target: string | null | undefined): string {
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
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/dashboard';
  }
}

export function evaluateAuthGuard(store: AuthStore, returnUrl?: string): true | string {
  if (!store.isSetupCompleted()) {
    return '/setup';
  }
  if (!store.isAuthenticated()) {
    const destination = sanitizeRedirectPath(returnUrl);
    return destination !== '/dashboard' && destination !== '/'
      ? `/login?redirect=${encodeURIComponent(destination)}`
      : '/login';
  }
  return true;
}

export function evaluatePermissionGuard(
  store: AuthStore,
  permission: PermissionKey,
  returnUrl?: string,
): true | string {
  const authResult = evaluateAuthGuard(store, returnUrl);
  if (authResult !== true) {
    return authResult;
  }
  return store.can(permission) ? true : '/dashboard';
}

export const authGuard: CanActivateFn = (_route, state) => {
  const store = inject(AuthStore);
  const router = inject(Router);
  const decision = evaluateAuthGuard(store, state.url);
  return decision === true ? true : router.parseUrl(decision);
};

export function createPermissionGuard(permission: PermissionKey): CanActivateFn {
  return (_route, state) => {
    const store = inject(AuthStore);
    const router = inject(Router);
    const decision = evaluatePermissionGuard(store, permission, state.url);
    return decision === true ? true : router.parseUrl(decision);
  };
}

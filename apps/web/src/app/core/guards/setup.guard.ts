import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { AuthStore } from '../auth/auth.store.js';

export function evaluateSetupCompletedGuard(store: AuthStore): true | string {
  return store.isSetupCompleted() ? true : '/setup';
}

export function evaluateSetupIncompleteGuard(store: AuthStore): true | string {
  return !store.isSetupCompleted() ? true : '/dashboard';
}

export const setupCompletedGuard: CanActivateFn = () => {
  const store = inject(AuthStore);
  const router = inject(Router);
  const decision = evaluateSetupCompletedGuard(store);
  return decision === true ? true : router.parseUrl(decision);
};

export const setupIncompleteGuard: CanActivateFn = () => {
  const store = inject(AuthStore);
  const router = inject(Router);
  const decision = evaluateSetupIncompleteGuard(store);
  return decision === true ? true : router.parseUrl(decision);
};

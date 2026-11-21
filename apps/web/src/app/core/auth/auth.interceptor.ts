import type { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthStore } from './auth.store.js';

export function buildAuthHeaders(token: string | null): Record<string, string> {
  if (!token || token.trim().length === 0) {
    return {};
  }
  return {
    Authorization: `Bearer ${token}`,
  };
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authStore = inject(AuthStore);
  const authHeaders = buildAuthHeaders(authStore.accessToken());

  const cloned = req.clone({
    withCredentials: true,
    setHeaders: authHeaders,
  });

  return next(cloned);
};

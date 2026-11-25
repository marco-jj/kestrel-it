import { HttpClient, HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { Injector, inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';
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
  if (!req.url.startsWith('/api/v1/')) return next(req);

  const store = inject(AuthStore);
  const injector = inject(Injector);
  const token = store.accessToken();
  const generation = store.sessionGeneration;
  const send = (accessToken: string | null) =>
    next(req.clone({ withCredentials: true, setHeaders: buildAuthHeaders(accessToken) }));
  const path = req.url.split('?')[0];
  const publicAuth = path.startsWith('/api/v1/auth/') && path !== '/api/v1/auth/me';

  return send(token).pipe(
    catchError((error: unknown) => {
      if (
        publicAuth || path === '/api/v1/logout' || path.startsWith('/api/v1/setup/') ||
        !store.isAuthenticated() || generation !== store.sessionGeneration ||
        !isAccessTokenFailure(error)
      ) {
        return throwError(() => error);
      }

      const currentToken = store.accessToken();
      if (currentToken && currentToken !== token) return send(currentToken);

      return from(store.refreshSession(injector.get(HttpClient))).pipe(
        switchMap((refreshedToken) => refreshedToken && generation === store.sessionGeneration
          ? send(refreshedToken)
          : throwError(() => error)),
      );
    }),
  );
};

function isAccessTokenFailure(error: unknown): boolean {
  if (!(error instanceof HttpErrorResponse) || error.status !== 401) return false;
  if (error.error instanceof Blob) return true; // Angular returns even JSON errors as blobs here.
  const message = error.error?.messages ?? error.error?.message;
  return message === 'Invalid or expired token' || message === 'Authentication required';
}

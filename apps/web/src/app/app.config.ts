import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { type ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { appRoutes } from './app.routes.js';
import { authInterceptor } from './core/auth/auth.interceptor.js';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(appRoutes),
    provideHttpClient(withInterceptors([authInterceptor])),
  ],
};

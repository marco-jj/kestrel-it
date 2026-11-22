import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { inject, provideAppInitializer, type ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { appRoutes } from './app.routes.js';
import { authInterceptor } from './core/auth/auth.interceptor.js';
import { AuthStore } from './core/auth/auth.store.js';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(appRoutes),
    provideHttpClient(withInterceptors([authInterceptor])),
    provideAppInitializer(() => inject(AuthStore).initialize(inject(HttpClient))),
  ],
};

import { CORE_INVENTORY_RESOURCES } from '@kestrel-it/shared';
import type { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard.js';
import { setupCompletedGuard, setupIncompleteGuard } from './core/guards/setup.guard.js';
import { AppShellComponent } from './core/layout/app-shell.component.js';
import { LoginComponent } from './features/auth/login.component.js';
import { DashboardComponent } from './features/dashboard/dashboard.component.js';
import { SetupWizardComponent } from './features/setup/setup-wizard.component.js';

export const appRoutes: Routes = [
  {
    path: 'setup',
    component: SetupWizardComponent,
    canActivate: [setupIncompleteGuard],
  },
  {
    path: 'login',
    component: LoginComponent,
    canActivate: [setupCompletedGuard],
  },
  {
    path: '',
    component: AppShellComponent,
    canActivate: [setupCompletedGuard, authGuard],
    children: [
      ...['fields', 'fieldsets'].map((path) => ({
        path,
        loadComponent: () => import('./features/inventory/custom-fields-page.component.js')
          .then((module) => module.CustomFieldsPageComponent),
      })),
      ...CORE_INVENTORY_RESOURCES.map((resource) => ({
        path: resource,
        data: { resource },
        loadComponent: () => import('./features/inventory/directory-page.component.js')
          .then((module) => module.DirectoryPageComponent),
      })),
      {
        path: 'dashboard',
        component: DashboardComponent,
      },
      {
        path: '',
        pathMatch: 'full',
        redirectTo: 'dashboard',
      },
    ],
  },
  {
    path: '**',
    redirectTo: 'dashboard',
  },
];

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

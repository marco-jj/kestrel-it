import { CORE_INVENTORY_RESOURCES } from '@kestrel-it/shared';
import type { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard.js';
import { setupCompletedGuard, setupIncompleteGuard } from './core/guards/setup.guard.js';
import { AppShellComponent } from './core/layout/app-shell.component.js';
import { LoginComponent } from './features/auth/login.component.js';
import { phaseThreeResources } from './features/inventory/phase-three-ui.js';
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
      ...['account/accept', 'account/accept/:id', 'account/eulas'].map((path) => ({
        path,
        loadComponent: () =>
          import('./features/inventory/acceptance-page.component.js').then(
            (module) => module.AcceptancePageComponent,
          ),
      })),
      ...['account/requestable', 'account/requests', 'requests'].map((path) => ({
        path,
        loadComponent: () =>
          import('./features/inventory/checkout-requests-page.component.js').then(
            (module) => module.CheckoutRequestsPageComponent,
          ),
      })),
      { path: 'account/requestable-assets', pathMatch: 'full', redirectTo: 'account/requestable' },
      ...['due', 'overdue', 'due-or-overdue'].map((status) => ({
        path: `hardware/audit/${status}`,
        data: { status },
        loadComponent: () => import('./features/inventory/audit-list.component.js').then((module) => module.AuditListComponent),
      })),
      ...phaseThreeResources.map((resource) => ({
        path: resource,
        data: { resource },
        loadComponent: () => import('./features/inventory/phase-three-page.component.js').then((module) => module.PhaseThreePageComponent),
      })),
      {
        path: 'calendar',
        loadComponent: () => import('./features/inventory/inventory-calendar.component.js').then((module) => module.InventoryCalendarComponent),
      },
      ...['reports', 'reports/:type', 'unaccepted-acceptances'].map((path) => ({
        path,
        loadComponent: () => import('./features/inventory/reports-page.component.js').then((module) => module.ReportsPageComponent),
      })),
      { path: 'import', loadComponent: () => import('./features/inventory/import-page.component.js').then((module) => module.ImportPageComponent) },
      { path: 'admin/labels', loadComponent: () => import('./features/inventory/labels-settings.component.js').then((module) => module.LabelsSettingsComponent) },
      ...['admin/settings', 'admin/notifications', 'admin/integrations'].map((path) => ({
        path,
        loadComponent: () => import('./features/inventory/notification-settings.component.js').then((module) => module.NotificationSettingsComponent),
      })),
      ...['hardware', 'hardware/bytag/:tag', 'hardware/:id', 'models'].map((path) => ({
        path,
        loadComponent: () =>
          import('./features/inventory/hardware-page.component.js').then(
            (module) => module.HardwarePageComponent,
          ),
      })),
      ...['fields', 'fieldsets'].map((path) => ({
        path,
        loadComponent: () =>
          import('./features/inventory/custom-fields-page.component.js').then(
            (module) => module.CustomFieldsPageComponent,
          ),
      })),
      ...CORE_INVENTORY_RESOURCES.map((resource) => ({
        path: resource,
        data: { resource },
        loadComponent: () =>
          import('./features/inventory/directory-page.component.js').then(
            (module) => module.DirectoryPageComponent,
          ),
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

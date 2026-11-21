import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, Inject, Optional, computed } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { PermissionKey } from '@kestrel-it/shared';
import { firstValueFrom } from 'rxjs';
import { AuthStore } from '../auth/auth.store.js';

export interface NavItem {
  label: string;
  route: string;
  section: 'overview' | 'inventory' | 'people' | 'operations' | 'admin';
  requiredPermission?: PermissionKey;
}

export const NAVIGATION_ITEMS: readonly NavItem[] = [
  { label: 'Dashboard', route: '/dashboard', section: 'overview' },
  { label: 'Assets', route: '/hardware', section: 'inventory', requiredPermission: 'assets.view' },
  { label: 'Asset Models', route: '/models', section: 'inventory', requiredPermission: 'models.view' },
  {
    label: 'Custom Fields',
    route: '/fields',
    section: 'inventory',
    requiredPermission: 'customfields.view',
  },
  {
    label: 'Licenses',
    route: '/licenses',
    section: 'inventory',
    requiredPermission: 'licenses.view',
  },
  {
    label: 'Accessories',
    route: '/accessories',
    section: 'inventory',
    requiredPermission: 'accessories.view',
  },
  {
    label: 'Consumables',
    route: '/consumables',
    section: 'inventory',
    requiredPermission: 'consumables.view',
  },
  {
    label: 'Components',
    route: '/components',
    section: 'inventory',
    requiredPermission: 'components.view',
  },
  { label: 'Kits', route: '/kits', section: 'inventory', requiredPermission: 'kits.view' },
  { label: 'Users', route: '/users', section: 'people', requiredPermission: 'users.view' },
  { label: 'Groups', route: '/groups', section: 'people', requiredPermission: 'admin' },
  {
    label: 'Companies',
    route: '/companies',
    section: 'people',
    requiredPermission: 'companies.view',
  },
  {
    label: 'Locations',
    route: '/locations',
    section: 'people',
    requiredPermission: 'locations.view',
  },
  { label: 'Imports', route: '/import', section: 'operations', requiredPermission: 'import' },
  {
    label: 'Reports',
    route: '/reports',
    section: 'operations',
    requiredPermission: 'reports.view',
  },
  {
    label: 'Settings',
    route: '/admin/settings',
    section: 'admin',
    requiredPermission: 'superuser',
  },
];

export function filterNavigationItems(store: AuthStore): NavItem[] {
  return NAVIGATION_ITEMS.filter(
    (item) => !item.requiredPermission || store.can(item.requiredPermission),
  );
}

@Component({
  selector: 'kestrel-app-shell',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">Kestrel-IT</div>
        <nav aria-label="Primary Navigation">
          @for (item of visibleNavItems(); track item.route) {
            <a
              class="nav-link"
              [routerLink]="item.route"
              routerLinkActive="active"
            >
              {{ item.label }}
            </a>
          }
        </nav>
      </aside>

      <div class="workspace">
        <header class="topbar">
          <div class="breadcrumbs">
            <span>Kestrel-IT</span>
            <span>/</span>
            <span>{{ activeCompanyLabel() }}</span>
          </div>
          <div class="topbar-actions">
            <span class="user-badge">{{ authStore.displayName() }}</span>
            <button type="button" class="logout-btn" (click)="logout()">Sign out</button>
          </div>
        </header>

        <main class="content">
          <router-outlet />
        </main>
      </div>
    </div>
  `,
  styles: [
    `
      .shell {
        display: flex;
        min-height: 100vh;
      }
      .sidebar {
        width: 240px;
        background: #102542;
        color: #f8fafc;
        padding: 1.25rem 0.75rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .brand {
        font-size: 1.125rem;
        font-weight: 700;
        padding: 0 0.75rem;
        letter-spacing: 0.02em;
      }
      nav {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .nav-link {
        color: #cbd5e1;
        text-decoration: none;
        padding: 0.5rem 0.75rem;
        border-radius: 6px;
        font-size: 0.9rem;
      }
      .nav-link:hover,
      .nav-link.active {
        background: rgba(255, 255, 255, 0.12);
        color: #ffffff;
      }
      .workspace {
        flex: 1;
        display: flex;
        flex-direction: column;
      }
      .topbar {
        height: 56px;
        background: #ffffff;
        border-bottom: 1px solid var(--kestrel-border);
        padding: 0 1.5rem;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .breadcrumbs {
        display: flex;
        gap: 0.5rem;
        color: var(--kestrel-muted);
        font-size: 0.875rem;
      }
      .topbar-actions {
        display: flex;
        align-items: center;
        gap: 1rem;
      }
      .user-badge {
        font-weight: 600;
        font-size: 0.875rem;
      }
      .logout-btn {
        border: 1px solid var(--kestrel-border);
        background: #ffffff;
        border-radius: 6px;
        padding: 0.35rem 0.75rem;
        cursor: pointer;
      }
      .content {
        padding: 1.5rem;
        flex: 1;
      }
    `,
  ],
})
export class AppShellComponent {
  readonly visibleNavItems = computed(() => filterNavigationItems(this.authStore));
  readonly activeCompanyLabel = computed(() => {
    const selectedId = this.authStore.selectedCompanyId();
    if (this.authStore.isSuperUser() && selectedId === null) {
      return 'All Companies (Superuser)';
    }
    return selectedId !== null ? `Company #${selectedId}` : 'Global Scope';
  });

  constructor(
    @Inject(AuthStore) readonly authStore: AuthStore,
    @Optional() @Inject(HttpClient) private readonly http?: HttpClient,
    @Optional() @Inject(Router) private readonly router?: Router,
  ) {}

  async logout(): Promise<void> {
    if (this.http) {
      try {
        await firstValueFrom(this.http.post('/api/v1/logout', {}));
      } catch {
        // Always clear local session even if server cookie already expired.
      }
    }
    this.authStore.clearSession();
    await this.router?.navigateByUrl('/login');
  }
}

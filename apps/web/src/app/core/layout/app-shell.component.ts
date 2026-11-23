import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, Inject, Optional, computed, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { PermissionKey } from '@kestrel-it/shared';
import { firstValueFrom } from 'rxjs';
import { AuthStore } from '../auth/auth.store.js';
import { ThemeStore } from '../theme/theme.store.js';
import { KestrelCommandPaletteComponent } from '../../shared/ui/command-palette.component.js';

export interface NavItem {
  label: string;
  route: string;
  section: 'overview' | 'inventory' | 'people' | 'operations' | 'admin';
  requiredPermission?: PermissionKey;
  directPermission?: boolean;
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
  { label: 'Departments', route: '/departments', section: 'people', requiredPermission: 'departments.view' },
  { label: 'Categories', route: '/categories', section: 'inventory', requiredPermission: 'categories.view' },
  { label: 'Manufacturers', route: '/manufacturers', section: 'inventory', requiredPermission: 'manufacturers.view' },
  { label: 'Suppliers', route: '/suppliers', section: 'inventory', requiredPermission: 'suppliers.view' },
  { label: 'Status Labels', route: '/statuslabels', section: 'inventory', requiredPermission: 'statuslabels.view' },
  { label: 'Checkout Acceptances', route: '/account/accept', section: 'operations' },
  { label: 'Requestable Inventory', route: '/account/requestable', section: 'operations',
    requiredPermission: 'assets.view.requestable', directPermission: true },
  { label: 'My Requests', route: '/account/requests', section: 'operations' },
  { label: 'Checkout Requests', route: '/requests', section: 'operations',
    requiredPermission: 'assets.checkout', directPermission: true },
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
    (item) => !item.requiredPermission || (item.directPermission
      ? store.currentUser()?.isSuperUser === true || store.currentUser()?.keyPermissions?.[item.requiredPermission] === true
      : store.can(item.requiredPermission)),
  );
}

const SECTION_LABELS: Record<NavItem['section'], string> = {
  overview: 'Overview',
  inventory: 'Inventory',
  people: 'People & Org',
  operations: 'Operations',
  admin: 'Administration',
};

@Component({
  selector: 'kestrel-app-shell',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    KestrelCommandPaletteComponent,
  ],
  template: `
    <div class="shell" [class.collapsed]="sidebarCollapsed()">
      <aside class="sidebar" [class.mobile-open]="mobileNavOpen()">
        <div class="sidebar-top">
          <div class="brand-wrap">
            <span class="brand-mark" aria-hidden="true">K</span>
            @if (!sidebarCollapsed()) {
              <div class="brand-text">
                <span class="brand">Kestrel-IT</span>
                <span class="brand-sub k-mono">ITAM v0.1</span>
              </div>
            }
          </div>
          <button
            type="button"
            class="k-btn k-btn-ghost icon-btn"
            (click)="toggleSidebar()"
            [attr.aria-label]="sidebarCollapsed() ? 'Expand sidebar' : 'Collapse sidebar'"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16" />
            </svg>
          </button>
        </div>

        <nav aria-label="Primary Navigation" class="nav-scroll">
          @for (group of navSections(); track group.section) {
            <div class="nav-group">
              @if (!sidebarCollapsed()) {
                <span class="nav-heading k-mono">{{ group.title }}</span>
              }
              @for (item of group.items; track item.route) {
                <a
                  class="nav-link"
                  [routerLink]="item.route"
                  routerLinkActive="active"
                  [title]="item.label"
                  (click)="mobileNavOpen.set(false)"
                >
                  <span class="nav-glyph k-mono" aria-hidden="true">{{ item.label.slice(0, 2) }}</span>
                  @if (!sidebarCollapsed()) {
                    <span class="nav-label">{{ item.label }}</span>
                  }
                </a>
              }
            </div>
          }
        </nav>
      </aside>

      <div class="workspace">
        <header class="topbar">
          <div class="topbar-left">
            <button
              type="button"
              class="k-btn k-btn-ghost mobile-menu-btn"
              (click)="mobileNavOpen.set(!mobileNavOpen())"
              aria-label="Toggle navigation"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M4 7h16M4 12h16M4 17h16" stroke-linecap="round" />
              </svg>
            </button>
            <div class="breadcrumbs">
              <span class="crumb-root">Kestrel-IT</span>
              <span class="crumb-sep">/</span>
              <span class="scope-pill k-mono">{{ activeCompanyLabel() }}</span>
            </div>
          </div>

          <div class="topbar-actions">
            <button
              type="button"
              class="k-btn k-btn-secondary cmd-trigger"
              (click)="openCommandPalette()"
            >
              <span>Quick Jump</span>
              <span class="k-kbd">⌘K</span>
            </button>

            <button
              type="button"
              class="k-btn k-btn-secondary theme-btn"
              (click)="toggleTheme()"
              [attr.aria-label]="themeStore.isDark() ? 'Switch to Light theme' : 'Switch to Dark theme'"
            >
              <span class="k-mono">{{ themeStore.isDark() ? 'DARK' : 'LIGHT' }}</span>
            </button>

            <div class="user-pill">
              <span class="user-dot" aria-hidden="true"></span>
              <span class="user-badge">{{ authStore.displayName() }}</span>
            </div>

            <button type="button" class="k-btn k-btn-secondary" (click)="logout()">
              Sign out
            </button>
          </div>
        </header>

        <main class="content">
          <div class="content-container">
            <router-outlet />
          </div>
        </main>
      </div>

      <kestrel-command-palette
        [open]="commandPaletteOpen()"
        (openChange)="commandPaletteOpen.set($event)"
      />
    </div>
  `,
  styles: [
    `
      .shell {
        display: grid;
        grid-template-columns: 248px minmax(0, 1fr);
        min-height: 100dvh;
        background: var(--kestrel-canvas);
        color: var(--kestrel-ink);
        transition: grid-template-columns 180ms var(--kestrel-ease-spring);
      }
      .shell.collapsed {
        grid-template-columns: 68px minmax(0, 1fr);
      }
      .sidebar {
        background: var(--kestrel-surface);
        border-right: 1px solid var(--kestrel-border);
        padding: 0.9rem 0.65rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
        position: sticky;
        top: 0;
        height: 100dvh;
      }
      .sidebar-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.4rem;
        padding: 0 0.2rem;
      }
      .brand-wrap {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        min-width: 0;
      }
      .brand-mark {
        width: 28px;
        height: 28px;
        border-radius: 7px;
        background: var(--kestrel-accent);
        color: var(--kestrel-accent-fg);
        display: grid;
        place-items: center;
        font-weight: 700;
        font-size: 0.85rem;
        flex-shrink: 0;
      }
      .brand-text {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .brand {
        font-size: 0.95rem;
        font-weight: 700;
        letter-spacing: -0.02em;
        line-height: 1.1;
      }
      .brand-sub {
        font-size: 0.68rem;
        color: var(--kestrel-muted);
      }
      .icon-btn {
        min-height: 30px;
        padding: 0.3rem;
      }
      .nav-scroll {
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 0.9rem;
      }
      .nav-group {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
      }
      .nav-heading {
        font-size: 0.65rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--kestrel-muted);
        padding: 0.25rem 0.6rem;
      }
      .nav-link {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        color: var(--kestrel-muted);
        text-decoration: none;
        padding: 0.44rem 0.6rem;
        border-radius: var(--kestrel-radius-md);
        font-size: 0.84rem;
        font-weight: 500;
        transition:
          background-color 140ms var(--kestrel-ease-spring),
          color 140ms var(--kestrel-ease-spring);
      }
      .nav-glyph {
        width: 22px;
        height: 22px;
        border-radius: 5px;
        background: var(--kestrel-surface-subtle);
        color: var(--kestrel-muted);
        font-size: 0.65rem;
        font-weight: 600;
        text-transform: uppercase;
        display: grid;
        place-items: center;
        flex-shrink: 0;
      }
      .nav-link:hover {
        background: var(--kestrel-surface-subtle);
        color: var(--kestrel-ink);
      }
      .nav-link.active {
        background: var(--kestrel-accent-subtle);
        color: var(--kestrel-accent);
        font-weight: 600;
      }
      .nav-link.active .nav-glyph {
        background: var(--kestrel-accent);
        color: var(--kestrel-accent-fg);
      }
      .workspace {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .topbar {
        position: sticky;
        top: 0;
        z-index: 30;
        height: 56px;
        background: var(--kestrel-surface);
        border-bottom: 1px solid var(--kestrel-border);
        padding: 0 1.25rem;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
      }
      .topbar-left {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }
      .mobile-menu-btn {
        display: none;
        padding: 0.35rem;
      }
      .breadcrumbs {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.82rem;
      }
      .crumb-root {
        color: var(--kestrel-muted);
        font-weight: 500;
      }
      .crumb-sep {
        color: var(--kestrel-border-strong);
      }
      .scope-pill {
        padding: 0.15rem 0.5rem;
        border-radius: 6px;
        background: var(--kestrel-surface-subtle);
        border: 1px solid var(--kestrel-border);
        font-size: 0.75rem;
      }
      .topbar-actions {
        display: flex;
        align-items: center;
        gap: 0.55rem;
      }
      .cmd-trigger,
      .theme-btn {
        min-height: 32px;
        padding: 0.25rem 0.6rem;
        font-size: 0.78rem;
      }
      .user-pill {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        padding: 0.25rem 0.6rem;
        border-radius: 999px;
        background: var(--kestrel-surface-subtle);
        border: 1px solid var(--kestrel-border);
      }
      .user-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--kestrel-accent);
      }
      .user-badge {
        font-weight: 600;
        font-size: 0.8rem;
      }
      .content {
        padding: 1.5rem;
        flex: 1;
      }
      .content-container {
        max-width: 1400px;
        margin: 0 auto;
      }
      @media (max-width: 768px) {
        .shell,
        .shell.collapsed {
          grid-template-columns: 1fr;
        }
        .mobile-menu-btn {
          display: inline-flex;
        }
        .sidebar {
          display: none;
          position: fixed;
          left: 0;
          top: 56px;
          width: 248px;
          height: calc(100dvh - 56px);
          z-index: 50;
        }
        .sidebar.mobile-open {
          display: flex;
        }
        .cmd-trigger span:first-child {
          display: none;
        }
      }
    `,
  ],
})
export class AppShellComponent {
  readonly themeStore: ThemeStore;
  readonly sidebarCollapsed = signal<boolean>(false);
  readonly mobileNavOpen = signal<boolean>(false);
  readonly commandPaletteOpen = signal<boolean>(false);

  readonly visibleNavItems = computed(() => filterNavigationItems(this.authStore));

  readonly navSections = computed(() => {
    const items = this.visibleNavItems();
    const order: NavItem['section'][] = ['overview', 'inventory', 'people', 'operations', 'admin'];
    return order
      .map((section) => ({
        section,
        title: SECTION_LABELS[section],
        items: items.filter((item) => item.section === section),
      }))
      .filter((group) => group.items.length > 0);
  });

  readonly activeCompanyLabel = computed(() => {
    const selectedId = this.authStore.selectedCompanyId();
    if (this.authStore.isSuperUser() && selectedId === null) {
      return 'All Companies (Superuser)';
    }
    return selectedId !== null ? `Company #${selectedId}` : 'Global Scope';
  });

  constructor(
    @Inject(AuthStore) readonly authStore: AuthStore,
    @Optional() @Inject(ThemeStore) themeStore?: ThemeStore,
    @Optional() @Inject(HttpClient) private readonly http?: HttpClient,
    @Optional() @Inject(Router) private readonly router?: Router,
  ) {
    this.themeStore = themeStore ?? new ThemeStore();
  }

  toggleSidebar(): void {
    this.sidebarCollapsed.update((collapsed) => !collapsed);
  }

  openCommandPalette(): void {
    this.commandPaletteOpen.set(true);
  }

  toggleTheme(): void {
    this.themeStore.toggleTheme();
  }

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

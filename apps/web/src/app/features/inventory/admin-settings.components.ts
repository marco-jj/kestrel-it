import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { StandardApiResponse } from '@kestrel-it/shared';
import { InventoryApi, inventoryError } from './inventory-api.js';

type SettingsSection = 'general' | 'branding' | 'integrations';

interface AdminSettingsModel {
  site_name: string;
  per_page: number;
  locale: string;
  default_currency: string;
  date_display_format: string;
  time_display_format: string;
  auto_increment_assets: boolean;
  auto_increment_prefix: string;
  next_auto_tag_base: number;
  zerofill_count: number;
  unique_serial: boolean;
  full_multiple_companies_support: boolean;
  scope_locations_fmcs: boolean;
  null_company_is_floater: boolean;
  default_eula_text: string | null;
  require_accept_signature: boolean;
  require_checkinout_notes: boolean;
  require_adjust_quantity_notes: boolean;
  depreciation_method: string;
  two_factor_enabled: number;
  pwd_secure_min: number;
  profile_edit: boolean;
  show_assigned_assets: boolean;
  show_archived_in_list: boolean;
  dash_chart_type: string;
  header_color: string | null;
  nav_link_color: string | null;
  link_light_color: string | null;
  link_dark_color: string | null;
  custom_css: string | null;
  footer_text: string | null;
  privacy_policy_link: string | null;
  dashboard_message: string | null;
  login_note: string | null;
  oidc_enabled: boolean;
  oidc_issuer_url: string | null;
  oidc_client_id: string | null;
  oidc_client_secret_configured: boolean;
  oidc_scopes: string;
  oidc_auto_provision_users: boolean;
  oidc_link_existing_users: boolean;
  oidc_sync_on_login: boolean;
  oidc_sync_groups: boolean;
  oidc_username_claim: string;
  oidc_groups_claim: string;
}

interface LoginAttemptRow {
  id: number;
  username: string;
  remote_ip: string | null;
  user_agent: string | null;
  successful: boolean;
  login_via: string;
  created_at: string;
}

const ADMIN_STYLES = `
  .admin-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  .admin-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    margin-bottom: 1rem;
  }
  .admin-nav a {
    text-decoration: none;
  }
  .admin-nav a.active {
    background: var(--kestrel-accent);
    color: var(--kestrel-accent-fg);
    border-color: var(--kestrel-accent);
  }
  .settings-grid {
    display: grid;
    gap: 0.9rem;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .field.full {
    grid-column: 1 / -1;
  }
  .check-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.88rem;
  }
  .section-card {
    padding: 1.15rem;
    margin-bottom: 1rem;
  }
  .section-card h2 {
    margin: 0 0 0.8rem;
    font-size: 1rem;
  }
  .notice-banner {
    padding: 0.65rem 0.85rem;
    border-radius: var(--kestrel-radius-md);
    border: 1px solid var(--kestrel-border-strong);
    background: var(--kestrel-surface-subtle);
    margin-bottom: 0.85rem;
  }
  [role='alert'] {
    color: var(--kestrel-danger);
    margin-bottom: 0.75rem;
  }
  .attempts-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.86rem;
  }
  .attempts-table th,
  .attempts-table td {
    text-align: left;
    padding: 0.55rem 0.6rem;
    border-bottom: 1px solid var(--kestrel-border);
  }
  .status-badge {
    display: inline-block;
    padding: 0.15rem 0.45rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    border: 1px solid var(--kestrel-border);
  }
  .status-badge.ok {
    background: var(--kestrel-accent-subtle);
    color: var(--kestrel-accent);
  }
  .status-badge.fail {
    color: var(--kestrel-danger);
  }
`;

@Component({
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <section class="admin-head">
      <div>
        <h1>Administration Settings</h1>
        <p class="k-helper">Configure instance rules, branding, security policies, and OIDC integration.</p>
      </div>
    </section>

    <nav class="admin-nav" aria-label="Administration sections">
      <a class="k-btn k-btn-secondary" [class.active]="section() === 'general'" routerLink="/admin/settings">General & Security</a>
      <a class="k-btn k-btn-secondary" [class.active]="section() === 'branding'" routerLink="/admin/branding">Branding & Copy</a>
      <a class="k-btn k-btn-secondary" [class.active]="section() === 'integrations'" routerLink="/admin/integrations">OIDC / SSO</a>
      <a class="k-btn k-btn-secondary" routerLink="/admin/notifications">Notifications</a>
      <a class="k-btn k-btn-secondary" routerLink="/admin/labels">Labels</a>
      <a class="k-btn k-btn-secondary" routerLink="/admin/login-attempts">Login Attempts</a>
    </nav>

    @if (error()) {
      <p role="alert">{{ error() }}</p>
    }
    @if (message()) {
      <p class="notice-banner" role="status">{{ message() }}</p>
    }

    @if (model; as cfg) {
      <form (ngSubmit)="save()">
        @if (section() === 'general') {
          <div class="k-card section-card">
            <h2>Instance & Tagging</h2>
            <div class="settings-grid">
              <label class="field">
                <span class="k-label">Site name</span>
                <input class="k-input" name="site_name" [(ngModel)]="cfg.site_name" required />
              </label>
              <label class="field">
                <span class="k-label">Rows per page</span>
                <input class="k-input" name="per_page" type="number" min="1" max="500" [(ngModel)]="cfg.per_page" />
              </label>
              <label class="field">
                <span class="k-label">Default locale</span>
                <input class="k-input" name="locale" [(ngModel)]="cfg.locale" />
              </label>
              <label class="field">
                <span class="k-label">Default currency</span>
                <input class="k-input" name="default_currency" maxlength="10" [(ngModel)]="cfg.default_currency" />
              </label>
              <label class="field">
                <span class="k-label">Asset tag prefix</span>
                <input class="k-input" name="auto_increment_prefix" [(ngModel)]="cfg.auto_increment_prefix" />
              </label>
              <label class="field">
                <span class="k-label">Next tag base (read-only)</span>
                <input class="k-input" name="next_auto_tag_base" type="number" [ngModel]="cfg.next_auto_tag_base" disabled />
              </label>
              <label class="field">
                <span class="k-label">Zerofill digits</span>
                <input class="k-input" name="zerofill_count" type="number" min="0" max="20" [(ngModel)]="cfg.zerofill_count" />
              </label>
              <label class="field">
                <span class="k-label">Depreciation method</span>
                <select class="k-select" name="depreciation_method" [(ngModel)]="cfg.depreciation_method">
                  <option value="default">Linear / Default</option>
                  <option value="half_1">Half-Year (Option 1)</option>
                  <option value="half_2">Half-Year (Option 2)</option>
                  <option value="diminish">Diminishing Value</option>
                </select>
              </label>
            </div>
            <div class="settings-grid" style="margin-top: 0.85rem;">
              <label class="check-row"><input type="checkbox" name="auto_increment_assets" [(ngModel)]="cfg.auto_increment_assets" /> Auto-increment asset tags</label>
              <label class="check-row"><input type="checkbox" name="unique_serial" [(ngModel)]="cfg.unique_serial" /> Enforce unique serial numbers</label>
              <label class="check-row"><input type="checkbox" name="full_multiple_companies_support" [(ngModel)]="cfg.full_multiple_companies_support" /> Full Multiple Companies Support (FMCS)</label>
              <label class="check-row"><input type="checkbox" name="scope_locations_fmcs" [(ngModel)]="cfg.scope_locations_fmcs" /> Scope locations in FMCS</label>
              <label class="check-row"><input type="checkbox" name="null_company_is_floater" [(ngModel)]="cfg.null_company_is_floater" /> Null company items act as floaters</label>
              <label class="check-row"><input type="checkbox" name="require_accept_signature" [(ngModel)]="cfg.require_accept_signature" /> Require acceptance signature</label>
              <label class="check-row"><input type="checkbox" name="require_checkinout_notes" [(ngModel)]="cfg.require_checkinout_notes" /> Require check-in/out notes</label>
              <label class="check-row"><input type="checkbox" name="require_adjust_quantity_notes" [(ngModel)]="cfg.require_adjust_quantity_notes" /> Require stock adjustment notes</label>
              <label class="check-row"><input type="checkbox" name="show_assigned_assets" [(ngModel)]="cfg.show_assigned_assets" /> Show assets assigned to user assets</label>
              <label class="check-row"><input type="checkbox" name="show_archived_in_list" [(ngModel)]="cfg.show_archived_in_list" /> Show archived assets in lists</label>
            </div>
          </div>

          <div class="k-card section-card">
            <h2>Authentication Policy & Default EULA</h2>
            <div class="settings-grid">
              <label class="field">
                <span class="k-label">Two-Factor Enforcement</span>
                <select class="k-select" name="two_factor_enabled" [(ngModel)]="cfg.two_factor_enabled">
                  <option [ngValue]="0">Disabled</option>
                  <option [ngValue]="1">Optional (user opt-in)</option>
                  <option [ngValue]="2">Mandatory for all users</option>
                </select>
              </label>
              <label class="field">
                <span class="k-label">Minimum password length</span>
                <input class="k-input" name="pwd_secure_min" type="number" min="6" max="128" [(ngModel)]="cfg.pwd_secure_min" />
              </label>
              <label class="check-row" style="align-self: end;">
                <input type="checkbox" name="profile_edit" [(ngModel)]="cfg.profile_edit" /> Allow user self-service profile editing
              </label>
              <label class="field full">
                <span class="k-label">Default EULA text</span>
                <textarea class="k-input" rows="4" name="default_eula_text" [(ngModel)]="cfg.default_eula_text"></textarea>
              </label>
            </div>
            <p class="k-helper" style="margin-top: 0.75rem;">
              Infrastructure note: PostgreSQL snapshots (<code class="k-mono">pg_dump</code>) and object-storage backups are managed externally by your operations platform.
            </p>
          </div>
        } @else if (section() === 'branding') {
          <div class="k-card section-card">
            <h2>Colors, Banners & Custom CSS</h2>
            <div class="settings-grid">
              <label class="field">
                <span class="k-label">Header color</span>
                <input class="k-input" name="header_color" placeholder="#0f172a" [(ngModel)]="cfg.header_color" />
              </label>
              <label class="field">
                <span class="k-label">Nav link color</span>
                <input class="k-input" name="nav_link_color" [(ngModel)]="cfg.nav_link_color" />
              </label>
              <label class="field">
                <span class="k-label">Link color (light)</span>
                <input class="k-input" name="link_light_color" [(ngModel)]="cfg.link_light_color" />
              </label>
              <label class="field">
                <span class="k-label">Link color (dark)</span>
                <input class="k-input" name="link_dark_color" [(ngModel)]="cfg.link_dark_color" />
              </label>
              <label class="field">
                <span class="k-label">Footer text</span>
                <input class="k-input" name="footer_text" [(ngModel)]="cfg.footer_text" />
              </label>
              <label class="field">
                <span class="k-label">Privacy policy URL</span>
                <input class="k-input" name="privacy_policy_link" [(ngModel)]="cfg.privacy_policy_link" />
              </label>
              <label class="field full">
                <span class="k-label">Dashboard banner message</span>
                <textarea class="k-input" rows="3" name="dashboard_message" [(ngModel)]="cfg.dashboard_message"></textarea>
              </label>
              <label class="field full">
                <span class="k-label">Login screen notice</span>
                <textarea class="k-input" rows="2" name="login_note" [(ngModel)]="cfg.login_note"></textarea>
              </label>
              <label class="field full">
                <span class="k-label">Custom CSS</span>
                <textarea class="k-input k-mono" rows="5" name="custom_css" [(ngModel)]="cfg.custom_css"></textarea>
              </label>
            </div>
          </div>
        } @else {
          <div class="k-card section-card">
            <h2>OIDC / OAuth 2.1 Single Sign-On</h2>
            <div class="settings-grid">
              <label class="check-row full">
                <input type="checkbox" name="oidc_enabled" [(ngModel)]="cfg.oidc_enabled" /> Enable OIDC login provider
              </label>
              <label class="field">
                <span class="k-label">Issuer URL</span>
                <input class="k-input" name="oidc_issuer_url" placeholder="https://idp.example.com" [(ngModel)]="cfg.oidc_issuer_url" />
              </label>
              <label class="field">
                <span class="k-label">Client ID</span>
                <input class="k-input" name="oidc_client_id" [(ngModel)]="cfg.oidc_client_id" />
              </label>
              <label class="field">
                <span class="k-label">
                  Client Secret ({{ cfg.oidc_client_secret_configured ? 'configured' : 'unset' }})
                </span>
                <input
                  class="k-input"
                  name="oidc_client_secret"
                  type="password"
                  placeholder="Enter replacement secret"
                  [(ngModel)]="newOidcSecret"
                />
              </label>
              <label class="field">
                <span class="k-label">Scopes</span>
                <input class="k-input" name="oidc_scopes" [(ngModel)]="cfg.oidc_scopes" />
              </label>
              <label class="field">
                <span class="k-label">Username claim</span>
                <input class="k-input" name="oidc_username_claim" [(ngModel)]="cfg.oidc_username_claim" />
              </label>
              <label class="field">
                <span class="k-label">Groups claim</span>
                <input class="k-input" name="oidc_groups_claim" [(ngModel)]="cfg.oidc_groups_claim" />
              </label>
            </div>
            <div class="settings-grid" style="margin-top: 0.85rem;">
              <label class="check-row"><input type="checkbox" name="oidc_auto_provision_users" [(ngModel)]="cfg.oidc_auto_provision_users" /> JIT provision new users</label>
              <label class="check-row"><input type="checkbox" name="oidc_link_existing_users" [(ngModel)]="cfg.oidc_link_existing_users" /> Link matching existing users</label>
              <label class="check-row"><input type="checkbox" name="oidc_sync_on_login" [(ngModel)]="cfg.oidc_sync_on_login" /> Sync profile attributes on login</label>
              <label class="check-row"><input type="checkbox" name="oidc_sync_groups" [(ngModel)]="cfg.oidc_sync_groups" /> Sync RBAC groups from claims</label>
              <label class="check-row"><input type="checkbox" name="clear_oidc_secret" [(ngModel)]="clearOidcSecret" /> Clear stored client secret</label>
            </div>
          </div>
        }

        <button type="submit" class="k-btn k-btn-primary" [disabled]="busy()">Save Settings</button>
      </form>
    }
  `,
  styles: [ADMIN_STYLES],
})
export class AdminSettingsComponent implements OnInit {
  private readonly api = inject(InventoryApi);
  private readonly route = inject(ActivatedRoute);

  readonly section = signal<SettingsSection>('general');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly message = signal('');

  model?: AdminSettingsModel;
  newOidcSecret = '';
  clearOidcSecret = false;

  ngOnInit(): void {
    const dataSection = this.route.snapshot.data['section'];
    if (dataSection === 'branding' || dataSection === 'integrations' || dataSection === 'general') {
      this.section.set(dataSection);
    }
    void this.load();
  }

  async load(): Promise<void> {
    this.error.set('');
    try {
      const response = await this.api.read<StandardApiResponse<AdminSettingsModel>>('/settings');
      this.model = response.payload ?? undefined;
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  async save(): Promise<void> {
    if (!this.model) return;
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    try {
      const { oidc_client_secret_configured: _cfg, next_auto_tag_base: _base, ...rest } = this.model;
      const nullableTrim = (value: string | null | undefined) => {
        const trimmed = value?.trim();
        return trimmed ? trimmed : null;
      };
      const body = {
        ...rest,
        per_page: Number(rest.per_page),
        zerofill_count: Number(rest.zerofill_count),
        two_factor_enabled: Number(rest.two_factor_enabled),
        pwd_secure_min: Number(rest.pwd_secure_min),
        auto_increment_prefix: rest.auto_increment_prefix?.trim() ?? '',
        header_color: nullableTrim(rest.header_color),
        nav_link_color: nullableTrim(rest.nav_link_color),
        link_light_color: nullableTrim(rest.link_light_color),
        link_dark_color: nullableTrim(rest.link_dark_color),
        privacy_policy_link: nullableTrim(rest.privacy_policy_link),
        oidc_issuer_url: nullableTrim(rest.oidc_issuer_url),
        oidc_client_id: nullableTrim(rest.oidc_client_id),
        oidc_scopes: rest.oidc_scopes?.trim() || 'openid profile email',
        oidc_username_claim: nullableTrim(rest.oidc_username_claim),
        oidc_groups_claim: nullableTrim(rest.oidc_groups_claim),
        ...(this.clearOidcSecret
          ? { oidc_client_secret: null }
          : this.newOidcSecret.trim()
            ? { oidc_client_secret: this.newOidcSecret.trim() }
            : {}),
      };
      const result = await this.api.write<AdminSettingsModel>('PATCH', '/settings', body);
      this.model = result.payload ?? undefined;
      this.newOidcSecret = '';
      this.clearOidcSecret = false;
      this.message.set('Settings saved');
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <section class="admin-head">
      <div>
        <h1>Login Attempts Audit</h1>
        <p class="k-helper">Inspect recent local and SSO authentication attempts recorded by the API.</p>
      </div>
    </section>

    <nav class="admin-nav" aria-label="Administration sections">
      <a class="k-btn k-btn-secondary" routerLink="/admin/settings">General & Security</a>
      <a class="k-btn k-btn-secondary" routerLink="/admin/branding">Branding & Copy</a>
      <a class="k-btn k-btn-secondary" routerLink="/admin/integrations">OIDC / SSO</a>
      <a class="k-btn k-btn-secondary" routerLink="/admin/notifications">Notifications</a>
      <a class="k-btn k-btn-secondary" routerLink="/admin/labels">Labels</a>
      <a class="k-btn k-btn-secondary active" routerLink="/admin/login-attempts">Login Attempts</a>
    </nav>

    @if (error()) {
      <p role="alert">{{ error() }}</p>
    }

    <div class="k-card section-card">
      <form (ngSubmit)="reloadFromFirst()" style="display: flex; gap: 0.6rem; margin-bottom: 0.9rem;">
        <input
          class="k-input"
          name="search"
          placeholder="Search username, IP, or auth method..."
          [(ngModel)]="search"
          style="max-width: 24rem;"
        />
        <button type="submit" class="k-btn k-btn-secondary">Filter</button>
      </form>

      <table class="attempts-table">
        <thead>
          <tr><th>Username</th><th>IP Address</th><th>Method</th><th>Outcome</th><th>User Agent</th><th>Timestamp</th></tr>
        </thead>
        <tbody>
          @for (row of rows(); track row.id) {
            <tr>
              <td>{{ row.username }}</td>
              <td class="k-mono">{{ row.remote_ip || '—' }}</td>
              <td class="k-mono">{{ row.login_via }}</td>
              <td>
                <span class="status-badge" [class.ok]="row.successful" [class.fail]="!row.successful">
                  {{ row.successful ? 'SUCCESS' : 'FAILED' }}
                </span>
              </td>
              <td>{{ row.user_agent || '—' }}</td>
              <td class="k-mono">{{ row.created_at }}</td>
            </tr>
          } @empty {
            <tr><td colspan="6" class="k-helper">No matching login attempts.</td></tr>
          }
        </tbody>
      </table>

      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.85rem;">
        <span class="k-helper">Total records: {{ total() }}</span>
        <div style="display: flex; gap: 0.5rem;">
          <button type="button" class="k-btn k-btn-secondary" [disabled]="offset() === 0" (click)="prev()">Previous</button>
          <button type="button" class="k-btn k-btn-secondary" [disabled]="offset() + limit >= total()" (click)="next()">Next</button>
        </div>
      </div>
    </div>
  `,
  styles: [ADMIN_STYLES],
})
export class LoginAttemptsComponent implements OnInit {
  private readonly api = inject(InventoryApi);
  readonly rows = signal<LoginAttemptRow[]>([]);
  readonly total = signal(0);
  readonly offset = signal(0);
  readonly error = signal('');
  readonly limit = 25;
  search = '';

  ngOnInit(): void {
    void this.load();
  }

  reloadFromFirst(): void {
    this.offset.set(0);
    void this.load();
  }

  prev(): void {
    this.offset.set(Math.max(0, this.offset() - this.limit));
    void this.load();
  }

  next(): void {
    this.offset.set(this.offset() + this.limit);
    void this.load();
  }

  async load(): Promise<void> {
    this.error.set('');
    try {
      const result = await this.api.records('/settings/login-attempts', {
        limit: this.limit,
        offset: this.offset(),
        ...(this.search.trim() ? { search: this.search.trim() } : {}),
      });
      this.rows.set((result.rows ?? []) as unknown as LoginAttemptRow[]);
      this.total.set(result.total ?? 0);
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }
}

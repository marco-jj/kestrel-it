import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type {
  CreatePatResponse,
  PatSummary,
  StandardApiResponse,
  TwoFactorEnrollResponse,
} from '@kestrel-it/shared';
import { LOCAL_PASSWORD_MAX_LENGTH } from '@kestrel-it/shared';
import { AuthStore } from '../../core/auth/auth.store.js';
import { formatDisplayDate } from '../../shared/ui/display-date.js';
import { DateInputComponent } from '../../shared/ui/date-input.component.js';
import { InventoryApi, inventoryError } from './inventory-api.js';
import { inventoryFormatErrors, phonePattern } from './inventory-field-validation.js';
import { FieldErrorComponent } from '../../shared/ui/field-validation.js';

interface AccountProfilePayload {
  id: number;
  username: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string;
  email: string | null;
  phone: string | null;
  locale: string;
  two_factor_enrolled: boolean;
  two_factor_policy: number;
  profile_edit: boolean;
  pwd_secure_min: number;
  has_local_password: boolean;
  auth_method: string;
}

interface AccountAssetsPayload {
  assets: Array<Record<string, unknown>>;
  licenses: Array<Record<string, unknown>>;
  accessories: Array<Record<string, unknown>>;
  consumables: Array<Record<string, unknown>>;
  pagination?: {
    current_page: number;
    total_pages: number;
    totals: Record<'assets' | 'licenses' | 'accessories' | 'consumables', number>;
  };
}

const ACCOUNT_SHARED_STYLES = `
  .account-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  .account-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    margin-bottom: 1rem;
  }
  .account-tab {
    text-decoration: none;
  }
  .account-tab.active {
    background: var(--kestrel-accent);
    color: var(--kestrel-accent-fg);
    border-color: var(--kestrel-accent);
  }
  .form-grid {
    display: grid;
    gap: 0.85rem;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .section-card {
    padding: 1.15rem;
    margin-bottom: 1rem;
  }
  .section-card h2 {
    margin: 0 0 0.75rem;
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
  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.86rem;
  }
  .data-table th,
  .data-table td {
    text-align: left;
    padding: 0.55rem 0.6rem;
    border-bottom: 1px solid var(--kestrel-border);
  }
  .token-reveal {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
    padding: 0.85rem;
    border: 1px solid var(--kestrel-accent);
    background: var(--kestrel-accent-subtle);
    border-radius: var(--kestrel-radius-md);
    margin-bottom: 1rem;
  }
`;

@Component({
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, FieldErrorComponent],
  template: `
    <section class="account-head">
      <div>
        <h1>My Profile</h1>
        <p class="k-helper">Manage personal contact information, local password, and two-factor security.</p>
      </div>
      <div class="account-tabs">
        <a class="k-btn k-btn-secondary account-tab active" routerLink="/account/profile">Profile & 2FA</a>
        <a class="k-btn k-btn-secondary account-tab" routerLink="/account/view-assets">My Assigned Items</a>
        <a class="k-btn k-btn-secondary account-tab" routerLink="/account/api">API Tokens</a>
      </div>
    </section>

    @if (error()) {
      <p role="alert">{{ error() }}</p>
    }
    @if (message()) {
      <p class="notice-banner" role="status">{{ message() }}</p>
    }

    @if (profile(); as p) {
      <div class="k-card section-card">
        <h2>Identity Details ({{ p.username }})</h2>
        @if (!canEditProfile(p)) {
          <p class="notice-banner">Self-service profile and password changes are disabled.</p>
        }
        <form (ngSubmit)="profileForm.valid && saveProfile()" #profileForm="ngForm" class="form-grid">
          <label class="field">
            <span class="k-label">First name</span>
            <input class="k-input" name="first_name" [(ngModel)]="firstName" [disabled]="!canEditProfile(p)" />
          </label>
          <label class="field">
            <span class="k-label">Last name</span>
            <input class="k-input" name="last_name" [(ngModel)]="lastName" [disabled]="!canEditProfile(p)" />
          </label>
          <label class="field">
            <span class="k-label">Display name</span>
            <input class="k-input" name="display_name" [(ngModel)]="displayName" [disabled]="!canEditProfile(p)" />
          </label>
          <div class="field">
            <label class="k-label" for="profile-email">Email</label>
            <input id="profile-email" class="k-input" name="email" type="email" [email]="email !== (p.email ?? '')"
              [(ngModel)]="email" #profileEmail="ngModel" [disabled]="!canEditProfile(p)"
              [attr.aria-invalid]="profileEmail.dirty && profileEmail.invalid ? 'true' : null"
              [attr.aria-describedby]="profileEmail.dirty && profileEmail.invalid ? 'profile-email-error' : null" />
            @if (profileEmail.dirty && profileEmail.invalid) {
              <small class="k-field-error" id="profile-email-error" aria-live="polite">{{ formatErrors.email }}</small>
            }
          </div>
          <div class="field">
            <label class="k-label" for="profile-phone">Phone</label>
            <input id="profile-phone" class="k-input" name="phone" type="tel" [pattern]="phone === (p.phone ?? '') ? '' : phonePattern"
              [(ngModel)]="phone" #profilePhone="ngModel" [disabled]="!canEditProfile(p)"
              [attr.aria-invalid]="profilePhone.dirty && profilePhone.invalid ? 'true' : null"
              [attr.aria-describedby]="profilePhone.dirty && profilePhone.invalid ? 'profile-phone-error' : null" />
            @if (profilePhone.dirty && profilePhone.invalid) {
              <small class="k-field-error" id="profile-phone-error" aria-live="polite">{{ formatErrors.tel }}</small>
            }
          </div>
          <label class="field">
            <span class="k-label">Locale</span>
            <input class="k-input" name="locale" [(ngModel)]="locale" [disabled]="!canEditProfile(p)" />
          </label>
          <div style="grid-column: 1 / -1; display: flex; gap: 0.6rem; align-items: center;">
            <button type="submit" class="k-btn k-btn-primary" [disabled]="busy() || !canEditProfile(p) || profileForm.invalid">
              Save Profile
            </button>
            <span class="k-helper">Signed in via <code class="k-mono">{{ p.auth_method }}</code></span>
          </div>
        </form>
      </div>

      @if (p.has_local_password && canEditProfile(p)) {
        <div class="k-card section-card">
          <h2>Change Password</h2>
          <form (ngSubmit)="passwordForm.valid && newPassword === confirmPassword && savePassword()" #passwordForm="ngForm" class="form-grid">
            <label class="field">
              <span class="k-label">Current password</span>
              <input class="k-input" name="current_password" type="password" [(ngModel)]="currentPassword"
                #currentPasswordField="ngModel" required [maxlength]="passwordMaxLength" autocomplete="current-password" />
              <kestrel-field-error [control]="currentPasswordField.control" />
            </label>
            <label class="field">
              <span class="k-label">New password (min {{ p.pwd_secure_min }} chars)</span>
              <input class="k-input" name="new_password" type="password" [(ngModel)]="newPassword"
                #newPasswordField="ngModel" required [minlength]="p.pwd_secure_min" [maxlength]="passwordMaxLength"
                autocomplete="new-password" />
              <kestrel-field-error [control]="newPasswordField.control" />
            </label>
            <label class="field">
              <span class="k-label">Confirm new password</span>
              <input class="k-input" name="confirm_password" type="password" [(ngModel)]="confirmPassword"
                #confirmPasswordField="ngModel" required autocomplete="new-password"
                [attr.aria-invalid]="confirmPasswordField.dirty && newPassword !== confirmPassword ? 'true' : null"
                [attr.aria-describedby]="confirmPasswordField.dirty && newPassword !== confirmPassword ? 'profile-password-match' : null" />
              @if (confirmPasswordField.dirty && newPassword !== confirmPassword) {
                <small class="k-field-error" id="profile-password-match" aria-live="polite">Passwords must match.</small>
              }
            </label>
            <div style="grid-column: 1 / -1;">
              <button type="submit" class="k-btn k-btn-secondary"
                [disabled]="busy() || passwordForm.invalid || newPassword !== confirmPassword">Update Password</button>
            </div>
          </form>
        </div>
      }

      <div class="k-card section-card">
        <h2>Two-Factor Authentication (TOTP)</h2>
        <p class="k-helper">
          Status: <strong>{{ p.two_factor_enrolled ? 'Enrolled' : 'Not enrolled' }}</strong>
          · Policy: <code class="k-mono">{{ policyLabel(p.two_factor_policy) }}</code>
        </p>
        @if (!p.two_factor_enrolled) {
          <button type="button" class="k-btn k-btn-secondary" [disabled]="busy()" (click)="startTwoFactorEnroll()">
            Generate 2FA Enrollment Secret
          </button>
        }
        @if (enrollment(); as totp) {
          <div class="notice-banner" style="margin-top: 0.85rem;">
            <p>Secret key: <code class="k-mono">{{ totp.secret }}</code></p>
            <p class="k-helper">Provisioning URI: <code class="k-mono">{{ totp.otpauthUri }}</code></p>
            <form (ngSubmit)="verifyTwoFactor()" style="display: flex; gap: 0.5rem; margin-top: 0.6rem; flex-wrap: wrap;">
              <input
                class="k-input"
                name="totp_code"
                placeholder="6-digit code"
                maxlength="6"
                [(ngModel)]="totpCode"
                style="max-width: 11rem;"
              />
              <button type="submit" class="k-btn k-btn-primary" [disabled]="busy()">Verify & Enable 2FA</button>
            </form>
          </div>
        }
      </div>
    }
  `,
  styles: [ACCOUNT_SHARED_STYLES],
})
export class AccountProfileComponent implements OnInit {
  private readonly api = inject(InventoryApi);
  readonly auth = inject(AuthStore);

  readonly profile = signal<AccountProfilePayload | null>(null);
  readonly enrollment = signal<TwoFactorEnrollResponse | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly message = signal('');

  firstName = '';
  lastName = '';
  displayName = '';
  email = '';
  phone = '';
  readonly phonePattern = phonePattern;
  readonly passwordMaxLength = LOCAL_PASSWORD_MAX_LENGTH;
  readonly formatErrors = inventoryFormatErrors;
  locale = 'en-US';
  currentPassword = '';
  newPassword = '';
  confirmPassword = '';
  totpCode = '';

  ngOnInit(): void {
    void this.load();
  }

  canEditProfile(profile: AccountProfilePayload): boolean {
    return profile.profile_edit || this.auth.isSuperUser();
  }

  policyLabel(policy: number): string {
    if (policy >= 2) return 'mandatory';
    if (policy === 1) return 'optional';
    return 'disabled';
  }

  async load(): Promise<void> {
    this.error.set('');
    try {
      const response = await this.api.read<StandardApiResponse<AccountProfilePayload>>('/account/profile');
      if (response.payload) {
        this.applyProfile(response.payload);
      }
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  private applyProfile(data: AccountProfilePayload): void {
    this.profile.set(data);
    this.firstName = data.first_name ?? '';
    this.lastName = data.last_name ?? '';
    this.displayName = data.display_name ?? '';
    this.email = data.email ?? '';
    this.phone = data.phone ?? '';
    this.locale = data.locale ?? 'en-US';
  }

  async saveProfile(): Promise<void> {
    const current = this.profile();
    if (!current || !this.canEditProfile(current)) return;
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    try {
      const response = await this.api.write<AccountProfilePayload>('PATCH', '/account/profile', {
        first_name: this.firstName.trim() || null,
        last_name: this.lastName.trim() || null,
        display_name: this.displayName.trim() || undefined,
        email: this.email.trim() || null,
        phone: this.phone.trim() || null,
        locale: this.locale.trim() || 'en-US',
      });
      if (response.payload) {
        this.applyProfile(response.payload);
      }
      this.message.set('Profile details updated');
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.busy.set(false);
    }
  }

  async savePassword(): Promise<void> {
    const current = this.profile();
    if (!current?.has_local_password || !this.canEditProfile(current) || this.busy()) return;
    if (this.newPassword.length < current.pwd_secure_min) {
      this.error.set(`Password must be at least ${current.pwd_secure_min} characters`);
      return;
    }
    if (this.newPassword !== this.confirmPassword) {
      this.error.set('New password confirmation does not match');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    try {
      const response = await this.api.write<AccountProfilePayload>('PATCH', '/account/profile', {
        current_password: this.currentPassword,
        new_password: this.newPassword,
      });
      if (response.payload) {
        this.applyProfile(response.payload);
      }
      this.currentPassword = '';
      this.newPassword = '';
      this.confirmPassword = '';
      this.message.set('Password updated successfully');
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.busy.set(false);
    }
  }

  async startTwoFactorEnroll(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    try {
      const result = await this.api.command<TwoFactorEnrollResponse>('/auth/2fa/enroll', {});
      this.enrollment.set(result);
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.busy.set(false);
    }
  }

  async verifyTwoFactor(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    try {
      await this.api.command('/auth/2fa/verify', { code: this.totpCode.trim() });
      this.enrollment.set(null);
      this.totpCode = '';
      this.message.set('Two-factor authentication enrolled');
      await this.load();
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <section class="account-head">
      <div>
        <h1>My Assigned Inventory</h1>
        <p class="k-helper">View all assets, software licenses, accessories, and consumables assigned to your account.</p>
      </div>
      <div class="account-tabs">
        <a class="k-btn k-btn-secondary account-tab" routerLink="/account/profile">Profile & 2FA</a>
        <a class="k-btn k-btn-secondary account-tab active" routerLink="/account/view-assets">My Assigned Items</a>
        <a class="k-btn k-btn-secondary account-tab" routerLink="/account/accept">Pending Acceptances</a>
        <a class="k-btn k-btn-secondary account-tab" routerLink="/account/requestable">Request Equipment</a>
      </div>
    </section>

    @if (error()) {
      <p role="alert">{{ error() }}</p>
    }

    @if (summary(); as data) {
      @if (data.pagination; as pagination) {
        @if (pagination.total_pages > 1 || pagination.current_page > 1) {
          <nav aria-label="Assigned inventory pages" class="account-tabs">
            <button type="button" class="k-btn k-btn-secondary"
              [disabled]="loading() || pagination.current_page <= 1"
              (click)="load(pagination.current_page - 1)">Previous</button>
            <span role="status">Page {{ pagination.current_page }} of {{ pagination.total_pages || 1 }}</span>
            <button type="button" class="k-btn k-btn-secondary"
              [disabled]="loading() || pagination.current_page >= pagination.total_pages"
              (click)="load(pagination.current_page + 1)">Next</button>
          </nav>
        }
      }
      <div class="k-card section-card">
        <h2>Hardware Assets ({{ data.pagination?.totals?.assets ?? data.assets.length }})</h2>
        @if (data.assets.length) {
          <table class="data-table">
            <thead>
              <tr><th>Asset Tag</th><th>Name</th><th>Serial</th><th>Status</th><th>Action</th></tr>
            </thead>
            <tbody>
              @for (item of data.assets; track item['id']) {
                <tr>
                  <td class="k-mono">{{ item['asset_tag'] }}</td>
                  <td>{{ item['name'] || '—' }}</td>
                  <td class="k-mono">{{ item['serial'] || '—' }}</td>
                  <td>{{ item['status_meta'] || 'deployed' }}</td>
                  <td><a class="k-btn k-btn-ghost" [routerLink]="['/hardware', item['id']]">Inspect</a></td>
                </tr>
              }
            </tbody>
          </table>
        } @else if (data.pagination?.totals?.assets) {
          <p class="k-helper">No items in this category on this page.</p>
        } @else {
          <p class="k-helper">No hardware assets currently checked out to you.</p>
        }
      </div>

      <div class="k-card section-card">
        <h2>Software Licenses ({{ data.pagination?.totals?.licenses ?? data.licenses.length }})</h2>
        @if (data.licenses.length) {
          <table class="data-table">
            <thead>
              <tr><th>License</th><th>Seat</th><th>Serial Key</th><th>Expires</th></tr>
            </thead>
            <tbody>
              @for (item of data.licenses; track item['seat_id'] || $index) {
                <tr>
                  <td>{{ item['name'] }}</td>
                  <td class="k-mono">{{ item['seat_id'] || '—' }}</td>
                  <td class="k-mono">{{ item['serial'] || 'Redacted' }}</td>
                  <td>{{ formatDate(item['expiration_date']) || '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
        } @else if (data.pagination?.totals?.licenses) {
          <p class="k-helper">No items in this category on this page.</p>
        } @else {
          <p class="k-helper">No license seats assigned to your account.</p>
        }
      </div>

      <div class="k-card section-card">
        <h2>Accessories ({{ data.pagination?.totals?.accessories ?? data.accessories.length }})</h2>
        @if (data.accessories.length) {
          <table class="data-table">
            <thead>
              <tr><th>Accessory</th><th>Checked Out</th><th>Note</th></tr>
            </thead>
            <tbody>
              @for (item of data.accessories; track item['assignment_id'] || $index) {
                <tr>
                  <td>{{ item['name'] }}</td>
                  <td>{{ formatDate(item['checked_out_at'], true) || '—' }}</td>
                  <td>{{ item['note'] || '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
        } @else if (data.pagination?.totals?.accessories) {
          <p class="k-helper">No items in this category on this page.</p>
        } @else {
          <p class="k-helper">No accessories assigned.</p>
        }
      </div>

      <div class="k-card section-card">
        <h2>Consumables ({{ data.pagination?.totals?.consumables ?? data.consumables.length }})</h2>
        @if (data.consumables.length) {
          <table class="data-table">
            <thead>
              <tr><th>Consumable</th><th>Item No</th><th>Checked Out</th></tr>
            </thead>
            <tbody>
              @for (item of data.consumables; track item['assignment_id'] || $index) {
                <tr>
                  <td>{{ item['name'] }}</td>
                  <td class="k-mono">{{ item['item_no'] || '—' }}</td>
                  <td>{{ formatDate(item['checked_out_at'] || item['consumed_at'], true) || '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
        } @else if (data.pagination?.totals?.consumables) {
          <p class="k-helper">No items in this category on this page.</p>
        } @else {
          <p class="k-helper">No consumables issued to your account.</p>
        }
      </div>
    }
  `,
  styles: [ACCOUNT_SHARED_STYLES],
})
export class AccountAssetsComponent implements OnInit {
  readonly formatDate = formatDisplayDate;
  private readonly api = inject(InventoryApi);
  readonly summary = signal<AccountAssetsPayload | null>(null);
  readonly error = signal('');
  readonly loading = signal(false);

  ngOnInit(): void {
    void this.load();
  }

  async load(page = 1): Promise<void> {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set('');
    try {
      let requestedPage = page;
      while (true) {
        const { payload } = await this.api.read<StandardApiResponse<AccountAssetsPayload>>(
          '/account/assets',
          { page: requestedPage },
        );
        const lastPage = Math.max(1, payload?.pagination?.total_pages ?? requestedPage);
        if (requestedPage <= lastPage) {
          this.summary.set(payload);
          break;
        }
        requestedPage = lastPage;
      }
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.loading.set(false);
    }
  }
}

@Component({
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, DateInputComponent],
  template: `
    <section class="account-head">
      <div>
        <h1>Personal Access Tokens</h1>
        <p class="k-helper">Issue bearer tokens for automation scripts and REST API clients.</p>
      </div>
      <div class="account-tabs">
        <a class="k-btn k-btn-secondary account-tab" routerLink="/account/profile">Profile & 2FA</a>
        <a class="k-btn k-btn-secondary account-tab" routerLink="/account/view-assets">My Assigned Items</a>
        <a class="k-btn k-btn-secondary account-tab active" routerLink="/account/api">API Tokens</a>
      </div>
    </section>

    @if (error()) {
      <p role="alert">{{ error() }}</p>
    }
    @if (message()) {
      <p class="notice-banner" role="status">{{ message() }}</p>
    }

    @if (plaintextToken()) {
      <div class="token-reveal" role="status">
        <div>
          <strong>Copy your new token now — it will not be shown again:</strong>
          <div><code class="k-mono">{{ plaintextToken() }}</code></div>
        </div>
        <button type="button" class="k-btn k-btn-secondary" (click)="plaintextToken.set('')">Dismiss</button>
      </div>
    }

    @if (!canManageTokens()) {
      <div class="k-card section-card">
        <p>Your role does not grant the <code class="k-mono">self.api</code> permission to manage Personal Access Tokens.</p>
      </div>
    } @else {
      <div class="k-card section-card">
        <h2>Create Token</h2>
        <form #tokenForm="ngForm" (ngSubmit)="tokenForm.valid && createToken()" class="form-grid">
          <label class="field">
            <span class="k-label">Token name</span>
            <input class="k-input" name="token_name" placeholder="CI deploy bot" [(ngModel)]="tokenName" required />
          </label>
          <label class="field">
            <span class="k-label">Expiration date (optional)</span>
            <kestrel-date-input label="Expiration date (optional)" name="expires_date" [(ngModel)]="expiresDate" />
          </label>
          <div style="display: flex; align-items: flex-end;">
            <button type="submit" class="k-btn k-btn-primary" [disabled]="busy() || tokenForm.invalid || !tokenName.trim()">Generate Token</button>
          </div>
        </form>
      </div>

      <div class="k-card section-card">
        <h2>Active Tokens ({{ tokens().length }})</h2>
        @if (tokens().length) {
          <table class="data-table">
            <thead>
              <tr><th>Name</th><th>Created</th><th>Last Used</th><th>Expires</th><th>Action</th></tr>
            </thead>
            <tbody>
              @for (tok of tokens(); track tok.id) {
                <tr>
                  <td>{{ tok.name }}</td>
                  <td class="k-mono">{{ formatDate(tok.createdAt, true) || '—' }}</td>
                  <td class="k-mono">{{ formatDate(tok.lastUsedAt, true) || 'Never' }}</td>
                  <td class="k-mono">{{ formatDate(tok.expiresAt) || 'No expiry' }}</td>
                  <td>
                    <button type="button" class="k-btn k-btn-danger" [disabled]="busy()" (click)="revokeToken(tok.id)">
                      Revoke
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <p class="k-helper">No active personal access tokens.</p>
        }
      </div>
    }
  `,
  styles: [ACCOUNT_SHARED_STYLES],
})
export class AccountTokensComponent implements OnInit {
  readonly formatDate = formatDisplayDate;
  private readonly api = inject(InventoryApi);
  readonly auth = inject(AuthStore);

  readonly tokens = signal<PatSummary[]>([]);
  readonly plaintextToken = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly message = signal('');
  tokenName = '';
  expiresDate = '';

  ngOnInit(): void {
    if (this.canManageTokens()) {
      void this.load();
    }
  }

  canManageTokens(): boolean {
    const user = this.auth.currentUser();
    return Boolean(user?.isSuperUser || user?.keyPermissions?.['self.api']);
  }

  async load(): Promise<void> {
    this.error.set('');
    try {
      const items = await this.api.read<PatSummary[]>('/account/personal-access-tokens');
      this.tokens.set(Array.isArray(items) ? items : []);
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  async createToken(): Promise<void> {
    const name = this.tokenName.trim();
    if (!name) return;
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    try {
      const expiresAt = this.expiresDate ? `${this.expiresDate}T23:59:59.000Z` : null;
      const result = await this.api.write<CreatePatResponse>('POST', '/account/personal-access-tokens', {
        name,
        expiresAt,
      });
      if (result.payload?.token) {
        this.plaintextToken.set(result.payload.token);
      }
      this.tokenName = '';
      this.expiresDate = '';
      this.message.set('Personal access token created');
      await this.load();
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.busy.set(false);
    }
  }

  async revokeToken(id: string): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    try {
      await this.api.write('DELETE', `/account/personal-access-tokens/${id}`);
      this.message.set('Personal access token revoked');
      await this.load();
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.busy.set(false);
    }
  }
}

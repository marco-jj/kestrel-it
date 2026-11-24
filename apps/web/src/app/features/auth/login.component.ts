import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, Inject, Optional, type OnInit, computed, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import {
  LoginRequestSchema,
  TwoFactorVerifyRequestSchema,
  type AuthProvidersStatusResponse,
  type LoginResponse,
  type TwoFactorEnrollResponse,
} from '@kestrel-it/shared';
import { firstValueFrom } from 'rxjs';
import { AuthStore } from '../../core/auth/auth.store.js';
import { sanitizeRedirectPath } from '../../core/guards/auth.guard.js';
import { ThemeStore } from '../../core/theme/theme.store.js';

@Component({
  selector: 'kestrel-login',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  template: `
    <section class="split-auth">
      <aside class="brand-column">
        <div class="brand-header">
          <span class="brand-mark">K</span>
          <span class="brand-name">Kestrel-IT</span>
        </div>

        <div class="brand-body">
          <p class="k-mono tag-line">PRECISION IT ASSET MANAGEMENT</p>
          <h1>Zero-drift hardware, license &amp; security telemetry.</h1>
          <p class="lead">
            Enterprise inventory tracking with PostgreSQL JSONB custom fields, strict RBAC, and multi-company isolation.
          </p>

          <dl class="spec-grid k-mono">
            <div>
              <dt>AUTH PROTOCOLS</dt>
              <dd>Local · TOTP · OIDC · PKCE</dd>
            </div>
            <div>
              <dt>DATA LAYER</dt>
              <dd>PostgreSQL 16 + JSONB GIN</dd>
            </div>
          </dl>
        </div>

        <div class="brand-footer k-mono">
          <span>Self-hosted Kubernetes Ready</span>
          <span>WCAG AA Dual Theme</span>
        </div>
      </aside>

      <main class="form-column">
        <div class="top-controls">
          <button
            type="button"
            class="k-btn k-btn-secondary theme-toggle k-mono"
            (click)="toggleTheme()"
          >
            {{ themeStore.isDark() ? 'DARK MODE' : 'LIGHT MODE' }}
          </button>
        </div>

        <div class="auth-panel k-card">
          <div class="panel-head">
            <h2>{{ step() === 'credentials' ? 'Sign in to workspace' : 'Verify two-factor code' }}</h2>
            <p class="panel-sub">
              {{
                step() === 'credentials'
                  ? 'Authenticate with local credentials or configured SSO broker.'
                  : 'Enter the 6-digit TOTP code from your authenticator.'
              }}
            </p>
          </div>

          @if (errorMessage()) {
            <div class="error-banner" role="alert">{{ errorMessage() }}</div>
          }

          @if (step() === 'credentials') {
            @if (authStore.providersStatus()?.loginNote; as notice) {
              <p class="panel-sub" style="white-space: pre-wrap;">{{ notice }}</p>
            }
            <form class="form-stack" [formGroup]="loginForm" (ngSubmit)="submitCredentials()">
              <label class="k-label">
                <span>Username</span>
                <input
                  type="text"
                  class="k-input"
                  formControlName="username"
                  autocomplete="username"
                />
              </label>

              <label class="k-label">
                <span>Password</span>
                <input
                  type="password"
                  class="k-input"
                  formControlName="password"
                  autocomplete="current-password"
                />
              </label>

              <button type="submit" class="k-btn k-btn-primary submit-btn" [disabled]="submitting()">
                {{ submitting() ? 'Signing in...' : 'Sign In' }}
              </button>
            </form>

            @if (ssoEnabled()) {
              <div class="sso-divider">
                <span>or continue with SSO</span>
              </div>
              <a class="k-btn k-btn-secondary sso-btn" [href]="ssoLoginPath()">
                Sign in with {{ ssoLabel() }}
              </a>
            }
          }

          @if (step() === '2fa') {
            <form class="form-stack" [formGroup]="totpForm" (ngSubmit)="submitTwoFactor()">
              @if (totpEnrollment()) {
                <div class="enroll-box">
                  <span class="k-label">Provision Authenticator TOTP URI</span>
                  <code class="k-mono uri-code">{{ totpEnrollment()!.otpauthUri }}</code>
                </div>
              }

              <label class="k-label">
                <span>6-Digit Verification Code</span>
                <input
                  type="text"
                  class="k-input k-mono code-input"
                  formControlName="code"
                  maxlength="6"
                  autocomplete="one-time-code"
                />
              </label>

              <button type="submit" class="k-btn k-btn-primary submit-btn" [disabled]="submitting()">
                Verify Code
              </button>
            </form>
          }
        </div>
      </main>
    </section>
  `,
  styles: [
    `
      .split-auth {
        min-height: 100dvh;
        display: grid;
        grid-template-columns: 5fr 7fr;
        background: var(--kestrel-canvas);
      }
      .brand-column {
        background: var(--kestrel-surface);
        border-right: 1px solid var(--kestrel-border);
        padding: 2.25rem;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 2rem;
      }
      .brand-header {
        display: flex;
        align-items: center;
        gap: 0.65rem;
      }
      .brand-mark {
        width: 30px;
        height: 30px;
        border-radius: 7px;
        background: var(--kestrel-accent);
        color: var(--kestrel-accent-fg);
        display: grid;
        place-items: center;
        font-weight: 700;
      }
      .brand-name {
        font-weight: 700;
        font-size: 1rem;
        letter-spacing: -0.02em;
      }
      .tag-line {
        font-size: 0.72rem;
        letter-spacing: 0.12em;
        color: var(--kestrel-accent);
        margin: 0 0 0.75rem;
      }
      .brand-body h1 {
        margin: 0;
        font-size: clamp(1.65rem, 2.5vw, 2.2rem);
        line-height: 1.15;
        letter-spacing: -0.03em;
      }
      .lead {
        margin: 1rem 0 0;
        color: var(--kestrel-muted);
        max-width: 46ch;
      }
      .spec-grid {
        margin: 2rem 0 0;
        padding-top: 1.25rem;
        border-top: 1px solid var(--kestrel-border);
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 1rem;
      }
      .spec-grid dt {
        font-size: 0.68rem;
        color: var(--kestrel-muted);
      }
      .spec-grid dd {
        margin: 0.2rem 0 0;
        font-size: 0.78rem;
        font-weight: 600;
      }
      .brand-footer {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        font-size: 0.72rem;
        color: var(--kestrel-muted);
      }
      .form-column {
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        padding: 2rem;
        position: relative;
      }
      .top-controls {
        position: absolute;
        top: 1.25rem;
        right: 1.25rem;
      }
      .theme-toggle {
        min-height: 32px;
        font-size: 0.72rem;
      }
      .auth-panel {
        width: 100%;
        max-width: 420px;
        padding: 1.75rem;
      }
      .panel-head h2 {
        margin: 0;
        font-size: 1.2rem;
        letter-spacing: -0.02em;
      }
      .panel-sub {
        margin: 0.3rem 0 1.25rem;
        color: var(--kestrel-muted);
        font-size: 0.84rem;
      }
      .form-stack {
        display: flex;
        flex-direction: column;
        gap: 0.95rem;
      }
      .submit-btn,
      .sso-btn {
        min-height: 44px;
        width: 100%;
      }
      .sso-divider {
        margin: 1.15rem 0 0.9rem;
        text-align: center;
        font-size: 0.78rem;
        color: var(--kestrel-muted);
        border-top: 1px solid var(--kestrel-border);
        padding-top: 0.85rem;
      }
      .enroll-box {
        background: var(--kestrel-surface-subtle);
        border: 1px solid var(--kestrel-border);
        padding: 0.85rem;
        border-radius: var(--kestrel-radius-md);
        display: flex;
        flex-direction: column;
        gap: 0.45rem;
      }
      .uri-code {
        font-size: 0.74rem;
        overflow-wrap: anywhere;
      }
      .code-input {
        letter-spacing: 0.25em;
        font-size: 1.05rem;
      }
      .error-banner {
        background: var(--kestrel-danger-subtle);
        color: var(--kestrel-danger);
        border: 1px solid rgba(225, 29, 72, 0.28);
        padding: 0.65rem 0.85rem;
        border-radius: var(--kestrel-radius-md);
        margin-bottom: 1rem;
        font-size: 0.84rem;
        font-weight: 500;
      }
      @media (max-width: 768px) {
        .split-auth {
          grid-template-columns: 1fr;
        }
        .brand-column {
          border-right: 0;
          border-bottom: 1px solid var(--kestrel-border);
          padding: 1.5rem;
        }
        .spec-grid,
        .brand-footer {
          display: none;
        }
      }
    `,
  ],
})
export class LoginComponent implements OnInit {
  readonly themeStore: ThemeStore;
  readonly step = signal<'credentials' | '2fa'>('credentials');
  readonly submitting = signal<boolean>(false);
  readonly errorMessage = signal<string | null>(null);
  readonly totpEnrollment = signal<TwoFactorEnrollResponse | null>(null);

  readonly ssoEnabled = computed(() => this.authStore.providersStatus()?.sso.enabled ?? false);
  readonly ssoLoginPath = computed(() => {
    const base = this.authStore.providersStatus()?.sso.loginPath ?? '/api/v1/auth/oidc/login';
    const destination = this.postLoginRedirect();
    return destination !== '/dashboard' && destination !== '/'
      ? `${base}?redirect=${encodeURIComponent(destination)}`
      : base;
  });
  readonly ssoLabel = computed(() => {
    const protocol = this.authStore.providersStatus()?.sso.protocol ?? 'oidc';
    return protocol === 'oidc' ? 'OpenID Connect (OIDC)' : `OAuth (${protocol.toUpperCase()})`;
  });

  readonly loginForm = new FormGroup({
    username: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    password: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  readonly totpForm = new FormGroup({
    code: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^\d{6}$/)],
    }),
  });

  constructor(
    @Inject(AuthStore) protected readonly authStore: AuthStore,
    @Optional() @Inject(HttpClient) private readonly http?: HttpClient,
    @Optional() @Inject(Router) private readonly router?: Router,
    @Optional() @Inject(ThemeStore) themeStore?: ThemeStore,
    @Optional() @Inject(ActivatedRoute) private readonly route?: ActivatedRoute,
  ) {
    this.themeStore = themeStore ?? new ThemeStore();
  }

  toggleTheme(): void {
    this.themeStore.toggleTheme();
  }

  ngOnInit(): void {
    void this.initializeLogin();
  }

  private async initializeLogin(): Promise<void> {
    if (this.route?.snapshot.queryParamMap.get('sso') === 'challenge' && this.http) {
      try {
        const response = await firstValueFrom(
          this.http.get<LoginResponse>('/api/v1/auth/sso/challenge'),
        );
        await this.handleLoginResponse(response);
        return;
      } catch {
        this.errorMessage.set('Unable to continue single sign-on. Start sign-in again.');
      }
    }
    await this.loadProviders();
  }

  async loadProviders(): Promise<void> {
    if (!this.http) {
      return;
    }
    try {
      const status = await firstValueFrom(
        this.http.get<AuthProvidersStatusResponse>('/api/v1/auth/providers'),
      );
      this.authStore.setProvidersStatus(status);
    } catch {
      // Keep default local login visible if provider discovery temporarily fails.
    }
  }

  async submitCredentials(): Promise<void> {
    const parsed = LoginRequestSchema.safeParse(this.loginForm.getRawValue());
    if (!parsed.success) {
      this.errorMessage.set('Username and password are required.');
      return;
    }
    if (!this.http) {
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set(null);
    try {
      const response = await firstValueFrom(
        this.http.post<LoginResponse>('/api/v1/auth/login', parsed.data),
      );
      await this.handleLoginResponse(response);
    } catch {
      this.errorMessage.set('Invalid username or password.');
    } finally {
      this.submitting.set(false);
    }
  }

  private postLoginRedirect(): string {
    return sanitizeRedirectPath(this.route?.snapshot.queryParamMap.get('redirect'));
  }

  async handleLoginResponse(response: LoginResponse): Promise<void> {
    this.authStore.applyLoginResponse(response);
    if (response.status === '2fa_required') {
      this.step.set('2fa');
      if (response.requiresEnrollment && this.http) {
        const enrollment = await firstValueFrom(
          this.http.post<TwoFactorEnrollResponse>('/api/v1/auth/2fa/enroll', {
            challengeToken: response.challengeToken,
          }),
        );
        this.totpEnrollment.set(enrollment);
      }
      return;
    }

    await this.router?.navigateByUrl(this.postLoginRedirect());
  }

  async submitTwoFactor(): Promise<void> {
    const challengeToken = this.authStore.twoFactorChallengeToken();
    const parsed = TwoFactorVerifyRequestSchema.safeParse({
      challengeToken: challengeToken ?? undefined,
      code: this.totpForm.controls.code.value,
    });
    if (!parsed.success) {
      this.errorMessage.set(parsed.error.issues[0]?.message ?? 'Enter a valid 6-digit code.');
      return;
    }
    if (!this.http) {
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set(null);
    try {
      const response = await firstValueFrom(
        this.http.post<LoginResponse>('/api/v1/auth/2fa/verify', parsed.data),
      );
      this.authStore.applyLoginResponse(response);
      if (response.status === 'authenticated') {
        await this.router?.navigateByUrl(this.postLoginRedirect());
      }
    } catch {
      this.errorMessage.set('Invalid two-factor verification code.');
    } finally {
      this.submitting.set(false);
    }
  }
}

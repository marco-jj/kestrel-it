import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, Inject, Optional, type OnInit, computed, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import {
  LoginRequestSchema,
  TwoFactorVerifyRequestSchema,
  type AuthProvidersStatusResponse,
  type LoginResponse,
  type TwoFactorEnrollResponse,
} from '@kestrel-it/shared';
import { firstValueFrom } from 'rxjs';
import { AuthStore } from '../../core/auth/auth.store.js';

@Component({
  selector: 'kestrel-login',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  template: `
    <section class="login-page">
      <div class="kestrel-card login-card">
        <h1>Sign in to Kestrel-IT</h1>

        @if (errorMessage()) {
          <div class="error-banner" role="alert">{{ errorMessage() }}</div>
        }

        @if (step() === 'credentials') {
          <form class="form-stack" [formGroup]="loginForm" (ngSubmit)="submitCredentials()">
            <label>
              Username
              <input type="text" formControlName="username" autocomplete="username" />
            </label>
            <label>
              Password
              <input
                type="password"
                formControlName="password"
                autocomplete="current-password"
              />
            </label>
            <button type="submit" class="kestrel-btn-primary" [disabled]="submitting()">
              {{ submitting() ? 'Signing in...' : 'Sign In' }}
            </button>
          </form>

          @if (ssoEnabled()) {
            <div class="sso-divider">or continue with SSO</div>
            <a class="sso-button" [href]="ssoLoginPath()">
              Sign in with {{ ssoLabel() }}
            </a>
          }
        }

        @if (step() === '2fa') {
          <form class="form-stack" [formGroup]="totpForm" (ngSubmit)="submitTwoFactor()">
            <h2>Two-Factor Authentication</h2>
            @if (totpEnrollment()) {
              <div class="enroll-box">
                <p>Scan this TOTP URI in your authenticator app:</p>
                <code>{{ totpEnrollment()!.otpauthUri }}</code>
              </div>
            }
            <label>
              6-Digit Verification Code
              <input type="text" formControlName="code" maxlength="6" autocomplete="one-time-code" />
            </label>
            <button type="submit" class="kestrel-btn-primary" [disabled]="submitting()">
              Verify Code
            </button>
          </form>
        }
      </div>
    </section>
  `,
  styles: [
    `
      .login-page {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 2rem;
      }
      .login-card {
        width: 100%;
        max-width: 420px;
      }
      .form-stack {
        display: flex;
        flex-direction: column;
        gap: 0.9rem;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        font-size: 0.875rem;
        font-weight: 600;
      }
      input {
        padding: 0.55rem 0.7rem;
        border: 1px solid var(--kestrel-border);
        border-radius: 6px;
      }
      .sso-divider {
        text-align: center;
        margin: 1rem 0 0.75rem;
        color: var(--kestrel-muted);
        font-size: 0.825rem;
      }
      .sso-button {
        display: block;
        text-align: center;
        padding: 0.6rem 1rem;
        border: 1px solid var(--kestrel-border);
        border-radius: 8px;
        text-decoration: none;
        color: var(--kestrel-text);
        font-weight: 600;
      }
      .enroll-box {
        background: #f8fafc;
        border: 1px solid var(--kestrel-border);
        padding: 0.75rem;
        border-radius: 6px;
        overflow-wrap: anywhere;
      }
      .error-banner {
        background: #fee2e2;
        color: #991b1b;
        padding: 0.75rem;
        border-radius: 6px;
        margin-bottom: 1rem;
      }
    `,
  ],
})
export class LoginComponent implements OnInit {
  readonly step = signal<'credentials' | '2fa'>('credentials');
  readonly submitting = signal<boolean>(false);
  readonly errorMessage = signal<string | null>(null);
  readonly totpEnrollment = signal<TwoFactorEnrollResponse | null>(null);

  readonly ssoEnabled = computed(() => this.authStore.providersStatus()?.sso.enabled ?? false);
  readonly ssoLoginPath = computed(
    () => this.authStore.providersStatus()?.sso.loginPath ?? '/api/v1/auth/oidc/login',
  );
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
    @Inject(AuthStore) private readonly authStore: AuthStore,
    @Optional() @Inject(HttpClient) private readonly http?: HttpClient,
    @Optional() @Inject(Router) private readonly router?: Router,
  ) {}

  async ngOnInit(): Promise<void> {
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

    await this.router?.navigateByUrl('/dashboard');
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
        await this.router?.navigateByUrl('/dashboard');
      }
    } catch {
      this.errorMessage.set('Invalid two-factor verification code.');
    } finally {
      this.submitting.set(false);
    }
  }
}

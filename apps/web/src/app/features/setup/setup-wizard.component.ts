import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, Inject, Optional, type OnInit, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import {
  CompleteSetupRequestSchema,
  type CompleteSetupRequest,
  type LoginResponse,
  type PreflightStatusResponse,
} from '@kestrel-it/shared';
import { firstValueFrom } from 'rxjs';
import { AuthStore } from '../../core/auth/auth.store.js';
import { ThemeStore } from '../../core/theme/theme.store.js';

@Component({
  selector: 'kestrel-setup-wizard',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  template: `
    <section class="wizard-split">
      <aside class="rail-column">
        <div class="rail-top">
          <div class="brand-header">
            <span class="brand-mark">K</span>
            <span class="brand-name">Kestrel-IT Setup</span>
          </div>
          <p class="rail-desc">
            Initialize PostgreSQL telemetry, asset tag formatting, and your root Superuser account.
          </p>
        </div>

        <ol class="step-rail">
          <li [class.active]="currentStep() === 1" [class.done]="currentStep() > 1">
            <span class="step-num k-mono">01</span>
            <div>
              <strong>Pre-Flight Diagnostics</strong>
              <span>Database, Storage, OIDC &amp; SMTP</span>
            </div>
          </li>
          <li [class.active]="currentStep() === 2" [class.done]="currentStep() > 2">
            <span class="step-num k-mono">02</span>
            <div>
              <strong>Instance &amp; Asset Tags</strong>
              <span>FMCS, Currency, Auto-Increment</span>
            </div>
          </li>
          <li [class.active]="currentStep() === 3">
            <span class="step-num k-mono">03</span>
            <div>
              <strong>First Superuser</strong>
              <span>Root Operator &amp; Lock Setup</span>
            </div>
          </li>
        </ol>

        <div class="rail-foot k-mono">
          <span>Step {{ currentStep() }} / 3</span>
          <span>Auto-locks with HTTP 403</span>
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

        <div class="wizard-card k-card">
          <h1>Kestrel-IT First-Run Setup</h1>
          <p class="subtitle k-mono">Step {{ currentStep() }} of 3</p>

          @if (errorMessage()) {
            <div class="error-banner" role="alert">{{ errorMessage() }}</div>
          }

          @if (currentStep() === 1) {
            <div class="step-panel">
              <h2>1. Pre-Flight Environment Check</h2>
              @if (preflight()) {
                <ul class="check-list">
                  <li class="check-row">
                    <span>PostgreSQL Database</span>
                    <span
                      class="check-state k-mono"
                      [class.ok]="preflight()!.checks.database"
                      [class.fail]="!preflight()!.checks.database"
                    >
                      {{ preflight()!.checks.database ? 'READY' : 'UNAVAILABLE' }}
                    </span>
                  </li>
                  <li class="check-row">
                    <span>Storage Backend Writable</span>
                    <span
                      class="check-state k-mono"
                      [class.ok]="preflight()!.checks.storageWritable"
                      [class.fail]="!preflight()!.checks.storageWritable"
                    >
                      {{ preflight()!.checks.storageWritable ? 'READY' : 'NOT WRITABLE' }}
                    </span>
                  </li>
                  <li class="check-row">
                    <span>OIDC SSO Configured</span>
                    <span class="check-state k-mono">
                      {{ preflight()!.checks.oidcConfigured ? 'YES' : 'OPTIONAL' }}
                    </span>
                  </li>
                  <li class="check-row">
                    <span>SMTP Mail Configured</span>
                    <span class="check-state k-mono">
                      {{ preflight()!.checks.smtpConfigured ? 'YES' : 'OPTIONAL' }}
                    </span>
                  </li>
                </ul>
              } @else {
                <div class="skeleton-stack">
                  <div class="k-skeleton" style="height: 36px;"></div>
                  <div class="k-skeleton" style="height: 36px;"></div>
                  <div class="k-skeleton" style="height: 36px;"></div>
                </div>
              }

              <div class="actions">
                <button type="button" class="k-btn k-btn-secondary" (click)="loadStatus()">
                  Refresh Checks
                </button>
                <button
                  type="button"
                  class="k-btn k-btn-primary"
                  [disabled]="!canProceedFromStep1()"
                  (click)="goToStep(2)"
                >
                  Continue to Instance Settings
                </button>
              </div>
            </div>
          }

          @if (currentStep() === 2) {
            <form class="step-panel" [formGroup]="instanceForm">
              <h2>2. Instance &amp; Asset Tag Configuration</h2>
              <label class="k-label">
                <span>Site Name</span>
                <input type="text" class="k-input" formControlName="siteName" />
              </label>
              <div class="field-pair">
                <label class="k-label">
                  <span>Locale</span>
                  <input type="text" class="k-input k-mono" formControlName="locale" />
                </label>
                <label class="k-label">
                  <span>Default Currency</span>
                  <input type="text" class="k-input k-mono" formControlName="defaultCurrency" />
                </label>
              </div>
              <label class="checkbox-row">
                <input type="checkbox" formControlName="fullMultipleCompaniesSupport" />
                <span>Enable Full Multiple Company Support (FMCS)</span>
              </label>
              <label class="checkbox-row">
                <input type="checkbox" formControlName="autoIncrementAssets" />
                <span>Auto-increment Asset Tags</span>
              </label>
              <div class="field-pair">
                <label class="k-label">
                  <span>Asset Tag Prefix</span>
                  <input type="text" class="k-input k-mono" formControlName="autoIncrementPrefix" />
                </label>
                <label class="k-label">
                  <span>Asset Tag Zerofill Length</span>
                  <input type="number" class="k-input k-mono" formControlName="zerofillCount" />
                </label>
              </div>

              <div class="actions">
                <button type="button" class="k-btn k-btn-secondary" (click)="goToStep(1)">
                  Back
                </button>
                <button
                  type="button"
                  class="k-btn k-btn-primary"
                  [disabled]="!canProceedFromStep2()"
                  (click)="goToStep(3)"
                >
                  Continue to Superuser Account
                </button>
              </div>
            </form>
          }

          @if (currentStep() === 3) {
            <form class="step-panel" [formGroup]="adminForm" (ngSubmit)="submitSetup()">
              <h2>3. Create First Superuser</h2>
              <div class="field-pair">
                <label class="k-label">
                  <span>First Name</span>
                  <input type="text" class="k-input" formControlName="firstName" />
                </label>
                <label class="k-label">
                  <span>Last Name</span>
                  <input type="text" class="k-input" formControlName="lastName" />
                </label>
              </div>
              <label class="k-label">
                <span>Username</span>
                <input type="text" class="k-input" formControlName="username" />
              </label>
              <label class="k-label">
                <span>Email</span>
                <input type="email" class="k-input" formControlName="email" />
              </label>
              <label class="k-label">
                <span>Password</span>
                <input type="password" class="k-input" formControlName="password" />
                <span class="k-helper">Minimum 10 characters.</span>
              </label>

              <div class="actions">
                <button type="button" class="k-btn k-btn-secondary" (click)="goToStep(2)">
                  Back
                </button>
                <button
                  type="submit"
                  class="k-btn k-btn-primary"
                  [disabled]="submitting()"
                >
                  {{ submitting() ? 'Completing Setup...' : 'Complete Setup & Sign In' }}
                </button>
              </div>
            </form>
          }
        </div>
      </main>
    </section>
  `,
  styles: [
    `
      .wizard-split {
        min-height: 100dvh;
        display: grid;
        grid-template-columns: 4fr 8fr;
        background: var(--kestrel-canvas);
      }
      .rail-column {
        background: var(--kestrel-surface);
        border-right: 1px solid var(--kestrel-border);
        padding: 2rem;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 2rem;
      }
      .brand-header {
        display: flex;
        align-items: center;
        gap: 0.6rem;
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
      }
      .brand-name {
        font-weight: 700;
        font-size: 1rem;
      }
      .rail-desc {
        margin: 0.8rem 0 0;
        color: var(--kestrel-muted);
        font-size: 0.86rem;
      }
      .step-rail {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .step-rail li {
        display: flex;
        align-items: flex-start;
        gap: 0.75rem;
        padding: 0.7rem 0.8rem;
        border-radius: var(--kestrel-radius-md);
        border: 1px solid var(--kestrel-border);
        color: var(--kestrel-muted);
      }
      .step-rail li.active {
        border-color: var(--kestrel-accent);
        background: var(--kestrel-accent-subtle);
        color: var(--kestrel-ink);
      }
      .step-rail li.done {
        border-color: rgba(16, 185, 129, 0.35);
      }
      .step-rail li strong {
        display: block;
        font-size: 0.84rem;
      }
      .step-rail li span:last-child {
        font-size: 0.75rem;
      }
      .step-num {
        font-size: 0.74rem;
        font-weight: 700;
        color: var(--kestrel-accent);
        padding-top: 0.1rem;
      }
      .rail-foot {
        display: flex;
        justify-content: space-between;
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
      .wizard-card {
        width: 100%;
        max-width: 580px;
        padding: 1.75rem;
      }
      h1 {
        margin: 0;
        font-size: 1.3rem;
        letter-spacing: -0.02em;
      }
      h2 {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
      }
      .subtitle {
        color: var(--kestrel-muted);
        margin: 0.25rem 0 1.2rem;
        font-size: 0.78rem;
      }
      .step-panel {
        display: flex;
        flex-direction: column;
        gap: 0.95rem;
      }
      .field-pair {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.75rem;
      }
      .checkbox-row {
        display: flex;
        align-items: center;
        gap: 0.55rem;
        font-size: 0.84rem;
        font-weight: 500;
        cursor: pointer;
      }
      .check-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .check-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.6rem 0.8rem;
        border: 1px solid var(--kestrel-border);
        border-radius: var(--kestrel-radius-md);
        background: var(--kestrel-surface-subtle);
        font-size: 0.84rem;
      }
      .check-state {
        font-size: 0.72rem;
        font-weight: 700;
        color: var(--kestrel-muted);
      }
      .check-state.ok {
        color: var(--kestrel-success);
      }
      .check-state.fail {
        color: var(--kestrel-danger);
      }
      .skeleton-stack {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .actions {
        display: flex;
        justify-content: space-between;
        gap: 0.75rem;
        margin-top: 0.5rem;
      }
      .error-banner {
        background: var(--kestrel-danger-subtle);
        color: var(--kestrel-danger);
        border: 1px solid rgba(225, 29, 72, 0.28);
        padding: 0.65rem 0.85rem;
        border-radius: var(--kestrel-radius-md);
        margin-bottom: 1rem;
        font-size: 0.84rem;
      }
      @media (max-width: 768px) {
        .wizard-split {
          grid-template-columns: 1fr;
        }
        .rail-column {
          border-right: 0;
          border-bottom: 1px solid var(--kestrel-border);
          padding: 1.25rem;
        }
        .field-pair {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class SetupWizardComponent implements OnInit {
  readonly themeStore: ThemeStore;
  readonly currentStep = signal<1 | 2 | 3>(1);
  readonly preflight = signal<PreflightStatusResponse | null>(null);
  readonly errorMessage = signal<string | null>(null);
  readonly submitting = signal<boolean>(false);

  readonly instanceForm = new FormGroup({
    siteName: new FormControl('Kestrel-IT', { nonNullable: true, validators: [Validators.required] }),
    locale: new FormControl('en-US', { nonNullable: true }),
    defaultCurrency: new FormControl('USD', { nonNullable: true }),
    fullMultipleCompaniesSupport: new FormControl(false, { nonNullable: true }),
    autoIncrementAssets: new FormControl(true, { nonNullable: true }),
    autoIncrementPrefix: new FormControl('KST-', { nonNullable: true }),
    zerofillCount: new FormControl(5, { nonNullable: true }),
    emailDomain: new FormControl('', { nonNullable: true }),
    emailFormat: new FormControl('filastname', { nonNullable: true }),
  });

  readonly adminForm = new FormGroup({
    firstName: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    lastName: new FormControl('', { nonNullable: true }),
    username: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    email: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] }),
    password: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(10)],
    }),
  });

  constructor(
    @Inject(AuthStore) private readonly authStore: AuthStore,
    @Optional() @Inject(HttpClient) private readonly http?: HttpClient,
    @Optional() @Inject(Router) private readonly router?: Router,
    @Optional() @Inject(ThemeStore) themeStore?: ThemeStore,
  ) {
    this.themeStore = themeStore ?? new ThemeStore();
  }

  toggleTheme(): void {
    this.themeStore.toggleTheme();
  }

  ngOnInit(): void {
    void this.loadStatus();
  }

  async loadStatus(): Promise<void> {
    if (!this.http) {
      return;
    }
    this.errorMessage.set(null);
    try {
      const status = await firstValueFrom(this.http.get<PreflightStatusResponse>('/api/v1/setup/status'));
      this.preflight.set(status);
      this.authStore.setSetupStatus(status);
      if (status.setupCompleted) {
        await this.router?.navigateByUrl('/dashboard');
      }
    } catch {
      this.errorMessage.set('Unable to reach pre-flight status endpoint.');
    }
  }

  canProceedFromStep1(): boolean {
    const status = this.preflight();
    return Boolean(status?.checks.database && status.checks.storageWritable);
  }

  canProceedFromStep2(): boolean {
    return this.instanceForm.controls.siteName.value.trim().length > 0;
  }

  goToStep(step: 1 | 2 | 3): void {
    this.errorMessage.set(null);
    if (step >= 2 && !this.canProceedFromStep1()) {
      this.errorMessage.set('Database and writable storage checks must pass before continuing.');
      return;
    }
    if (step === 3 && !this.canProceedFromStep2()) {
      this.errorMessage.set('Site name is required before creating the initial superuser.');
      return;
    }
    this.currentStep.set(step);
  }

  buildPayload(): CompleteSetupRequest | null {
    const inst = this.instanceForm.getRawValue();
    const admin = this.adminForm.getRawValue();
    const parsed = CompleteSetupRequestSchema.safeParse({
      siteName: inst.siteName,
      locale: inst.locale,
      defaultCurrency: inst.defaultCurrency,
      fullMultipleCompaniesSupport: inst.fullMultipleCompaniesSupport,
      autoIncrementAssets: inst.autoIncrementAssets,
      autoIncrementPrefix: inst.autoIncrementPrefix || null,
      zerofillCount: inst.zerofillCount,
      emailDomain: inst.emailDomain || null,
      emailFormat: inst.emailFormat || null,
      firstName: admin.firstName,
      lastName: admin.lastName,
      username: admin.username,
      email: admin.email,
      password: admin.password,
    });

    if (!parsed.success) {
      this.errorMessage.set(parsed.error.issues[0]?.message || 'Invalid setup configuration.');
      return null;
    }

    return parsed.data;
  }

  async submitSetup(): Promise<void> {
    const payload = this.buildPayload();
    if (!payload || !this.http) {
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set(null);
    try {
      const response = await firstValueFrom(
        this.http.post<LoginResponse>('/api/v1/setup/complete', payload),
      );
      const currentStatus = this.preflight();
      if (currentStatus) {
        this.authStore.setSetupStatus({ ...currentStatus, setupCompleted: true });
      } else {
        this.authStore.setSetupStatus({
          setupCompleted: true,
          checks: {
            database: true,
            storageWritable: true,
            oidcConfigured: false,
            smtpConfigured: false,
          },
        });
      }
      this.authStore.applyLoginResponse(response);
      await this.router?.navigateByUrl('/dashboard');
    } catch {
      this.errorMessage.set('Failed to complete initial setup.');
    } finally {
      this.submitting.set(false);
    }
  }
}

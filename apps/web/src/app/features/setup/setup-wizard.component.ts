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

@Component({
  selector: 'kestrel-setup-wizard',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  template: `
    <section class="wizard-page">
      <div class="kestrel-card wizard-card">
        <h1>Kestrel-IT First-Run Setup</h1>
        <p class="subtitle">Step {{ currentStep() }} of 3</p>

        @if (errorMessage()) {
          <div class="error-banner" role="alert">{{ errorMessage() }}</div>
        }

        @if (currentStep() === 1) {
          <div class="step-panel">
            <h2>1. Pre-Flight Environment Check</h2>
            @if (preflight()) {
              <ul class="check-list">
                <li>PostgreSQL Database: {{ preflight()!.checks.database ? 'Ready' : 'Unavailable' }}</li>
                <li>
                  Storage Backend Writable:
                  {{ preflight()!.checks.storageWritable ? 'Ready' : 'Not Writable' }}
                </li>
                <li>OIDC SSO Configured: {{ preflight()!.checks.oidcConfigured ? 'Yes' : 'No (Optional)' }}</li>
                <li>SMTP Mail Configured: {{ preflight()!.checks.smtpConfigured ? 'Yes' : 'No (Optional)' }}</li>
              </ul>
            } @else {
              <p>Checking system requirements...</p>
            }

            <div class="actions">
              <button type="button" (click)="loadStatus()">Refresh Checks</button>
              <button
                type="button"
                class="kestrel-btn-primary"
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
            <label>
              Site Name
              <input type="text" formControlName="siteName" />
            </label>
            <label>
              Locale
              <input type="text" formControlName="locale" />
            </label>
            <label>
              Default Currency
              <input type="text" formControlName="defaultCurrency" />
            </label>
            <label class="checkbox-row">
              <input type="checkbox" formControlName="fullMultipleCompaniesSupport" />
              Enable Full Multiple Company Support (FMCS)
            </label>
            <label class="checkbox-row">
              <input type="checkbox" formControlName="autoIncrementAssets" />
              Auto-increment Asset Tags
            </label>
            <label>
              Asset Tag Prefix
              <input type="text" formControlName="autoIncrementPrefix" />
            </label>
            <label>
              Asset Tag Zerofill Length
              <input type="number" formControlName="zerofillCount" />
            </label>

            <div class="actions">
              <button type="button" (click)="goToStep(1)">Back</button>
              <button
                type="button"
                class="kestrel-btn-primary"
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
            <label>
              First Name
              <input type="text" formControlName="firstName" />
            </label>
            <label>
              Last Name
              <input type="text" formControlName="lastName" />
            </label>
            <label>
              Username
              <input type="text" formControlName="username" />
            </label>
            <label>
              Email
              <input type="email" formControlName="email" />
            </label>
            <label>
              Password (minimum 10 characters)
              <input type="password" formControlName="password" />
            </label>

            <div class="actions">
              <button type="button" (click)="goToStep(2)">Back</button>
              <button
                type="submit"
                class="kestrel-btn-primary"
                [disabled]="submitting()"
              >
                {{ submitting() ? 'Completing Setup...' : 'Complete Setup & Sign In' }}
              </button>
            </div>
          </form>
        }
      </div>
    </section>
  `,
  styles: [
    `
      .wizard-page {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 2rem;
      }
      .wizard-card {
        width: 100%;
        max-width: 580px;
      }
      .subtitle {
        color: var(--kestrel-muted);
        margin-top: -0.5rem;
      }
      .step-panel {
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
      .checkbox-row {
        flex-direction: row;
        align-items: center;
        gap: 0.5rem;
      }
      input[type='text'],
      input[type='email'],
      input[type='password'],
      input[type='number'] {
        padding: 0.55rem 0.7rem;
        border: 1px solid var(--kestrel-border);
        border-radius: 6px;
        font-size: 0.95rem;
      }
      .check-list {
        list-style: none;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .actions {
        display: flex;
        justify-content: space-between;
        margin-top: 0.5rem;
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
export class SetupWizardComponent implements OnInit {
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
  ) {}

  async ngOnInit(): Promise<void> {
    await this.loadStatus();
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
    return Boolean(status && status.checks.database && status.checks.storageWritable);
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

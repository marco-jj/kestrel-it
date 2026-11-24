import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { StandardApiResponse } from '@kestrel-it/shared';
import { InventoryApi, inventoryError } from './inventory-api.js';

interface NotificationSettings {
  alerts_enabled: boolean;
  alert_email: string | null;
  admin_cc_email: string | null;
  admin_cc_always: boolean;
  alert_interval: number | null;
  alert_threshold: number | null;
  audit_warning_days: number | null;
  due_checkin_days: number | null;
  webhook_selected: string | null;
  webhook_configured: boolean;
  webhook_channel: string | null;
  webhook_botname: string | null;
  timezone: string;
}
type NumericSetting =
  'alert_interval' | 'alert_threshold' | 'audit_warning_days' | 'due_checkin_days';

@Component({
  selector: 'kestrel-notification-settings',
  imports: [FormsModule],
  template: `
    <h1>Notification settings</h1>
    @if (model; as settings) {
      <form (ngSubmit)="save()" class="settings">
        <fieldset>
          <legend>Email and scheduling</legend>
          <label class="check"
            ><input name="alerts" type="checkbox" [(ngModel)]="settings.alerts_enabled" /> Enable
            scheduled alerts</label
          >
          <label
            >Alert recipients
            <input
              name="alert-email"
              [(ngModel)]="settings.alert_email"
              placeholder="Email addresses separated by commas"
          /></label>
          <label
            >Admin CC recipients <input name="cc-email" [(ngModel)]="settings.admin_cc_email"
          /></label>
          <label class="check"
            ><input name="cc" type="checkbox" [(ngModel)]="settings.admin_cc_always" /> Always copy
            administrators on check-in and checkout</label
          >
          <div class="toolbar">
            @for (field of numbers; track field.key) {
              <label
                >{{ field.label }}
                <input type="number" min="0" [name]="field.key" [(ngModel)]="settings[field.key]"
              /></label>
            }
          </div>
          <p>Scheduler timezone {{ settings.timezone }}</p>
        </fieldset>
        <fieldset>
          <legend>Global webhook</legend>
          <label
            >Provider
            <select name="provider" [(ngModel)]="settings.webhook_selected">
              <option [ngValue]="null">None</option>
              <option value="slack">Slack</option>
              <option value="microsoft">Microsoft Teams</option>
              <option value="google">Google Chat</option>
              <option value="general">Generic JSON</option>
            </select></label
          >
          <label
            >Webhook URL
            <input
              name="endpoint"
              type="password"
              [(ngModel)]="endpoint"
              autocomplete="new-password"
              [placeholder]="settings.webhook_configured ? 'Configured' : 'Public HTTPS URL'"
          /></label>
          @if (settings.webhook_configured) {
            <label class="check"
              ><input name="clear" type="checkbox" [(ngModel)]="clearEndpoint" /> Remove configured
              URL</label
            >
          }
          <label>Channel <input name="channel" [(ngModel)]="settings.webhook_channel" /></label>
          <label>Bot name <input name="bot" [(ngModel)]="settings.webhook_botname" /></label>
        </fieldset>
        <button type="submit" class="k-btn k-btn-primary" [disabled]="busy()">
          Save notification settings
        </button>
      </form>
      <form class="toolbar" (ngSubmit)="test()">
        <label
          >Test recipient
          <input
            name="test-email"
            type="email"
            [(ngModel)]="testEmail"
            placeholder="Use my email address"
        /></label>
        <button class="k-btn k-btn-secondary" type="submit" [disabled]="busy()">
          Send test email
        </button>
      </form>
    }
    @if (message()) {
      <p role="status">{{ message() }}</p>
    }
    @if (error()) {
      <p role="alert">{{ error() }}</p>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      h1 {
        font-size: 1.6rem;
        font-weight: 650;
        margin-bottom: 1rem;
      }
      .settings {
        display: grid;
        gap: 1rem;
        max-width: 56rem;
      }
      fieldset {
        border: 1px solid var(--kestrel-border);
        padding: 1rem;
        border-radius: 0.5rem;
      }
      label {
        display: grid;
        gap: 0.25rem;
        margin: 0.5rem 0;
      }
      .check {
        display: flex;
        align-items: center;
        gap: 0.4rem;
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        align-items: end;
      }
      .toolbar input[type='number'] {
        width: 8rem;
      }
      form + form {
        margin-block: 1rem;
      }
      [role='alert'] {
        color: var(--kestrel-danger);
      }
    `,
  ],
})
export class NotificationSettingsComponent implements OnInit {
  private readonly api = inject(InventoryApi);
  readonly message = signal('');
  readonly error = signal('');
  readonly busy = signal(false);
  readonly numbers: { key: NumericSetting; label: string }[] = [
    { key: 'alert_interval', label: 'Expiry warning days' },
    { key: 'alert_threshold', label: 'Low-stock buffer' },
    { key: 'audit_warning_days', label: 'Audit warning days' },
    { key: 'due_checkin_days', label: 'Expected return warning days' },
  ];
  model?: NotificationSettings;
  endpoint = '';
  clearEndpoint = false;
  testEmail = '';

  ngOnInit() {
    void this.load();
  }
  async load() {
    try {
      this.model =
        (await this.api.read<StandardApiResponse<NotificationSettings>>('/settings/notifications'))
          .payload ?? undefined;
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  async save() {
    if (!this.model) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const { webhook_configured, timezone, ...body } = this.model;
      const result = await this.api.write<NotificationSettings>(
        'PATCH',
        '/settings/notifications',
        {
          ...body,
          ...(this.clearEndpoint || body.webhook_selected === null
            ? { webhook_endpoint: null }
            : this.endpoint.trim()
              ? { webhook_endpoint: this.endpoint.trim() }
              : {}),
        },
      );
      this.model = result.payload ?? undefined;
      this.endpoint = '';
      this.clearEndpoint = false;
      this.message.set('Notification settings saved');
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.busy.set(false);
    }
  }

  async test() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.write(
        'POST',
        '/settings/notifications/test',
        this.testEmail ? { email: this.testEmail } : {},
      );
      this.message.set('Test email queued');
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.busy.set(false);
    }
  }
}

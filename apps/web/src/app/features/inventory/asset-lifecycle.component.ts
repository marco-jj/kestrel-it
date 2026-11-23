import { Component, EventEmitter, Input, OnInit, Output, inject, signal } from '@angular/core';
import {
  FormControl,
  FormGroup,
  FormRecord,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import type {
  CheckoutTargetType,
  InventoryCustomField,
  SelectlistResponse,
} from '@kestrel-it/shared';
import {
  KestrelAsyncSelectComponent,
  type AsyncSelectOption,
} from '../../shared/ui/async-select.component.js';
import type { DataGridRow } from '../../shared/ui/data-grid.component.js';
import {
  CustomFieldFormSectionComponent,
  customFieldChanges,
} from './custom-field-form-section.component.js';
import { field, reference } from './directory-ui.js';
import { InventoryApi, companyQuery, inventoryError } from './inventory-api.js';
import { InventoryFormFieldsComponent } from './inventory-form-fields.component.js';

@Component({
  selector: 'kestrel-asset-lifecycle',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    KestrelAsyncSelectComponent,
    InventoryFormFieldsComponent,
    CustomFieldFormSectionComponent,
  ],
  template: `
    <p>{{ asset['asset_tag'] }} {{ asset['name'] }}</p>
    <form [formGroup]="form" (ngSubmit)="submit()">
      @if (action === 'checkout') {
        <label
          >Assign to
          <select formControlName="target_type" (change)="targetChanged()">
            <option value="user">User</option>
            <option value="location">Location</option>
            <option value="asset">Asset</option>
          </select>
        </label>
        <kestrel-async-select
          label="Checkout target"
          formControlName="target_id"
          [options]="targets()"
          [companyId]="assetCompanyId"
          [allowQuickCreate]="false"
          (searchChanged)="searchTargets($event)"
        />
      }
      <kestrel-inventory-form-fields
        [form]="form"
        [companyId]="assetCompanyId"
        [fields]="action === 'checkout' ? checkoutFields : checkinFields"
      />
      @if (fields().length) {
        <kestrel-custom-field-form-section
          [fields]="fields()"
          [values]="values()"
          [form]="custom"
        />
      }
      @if (error()) {
        <p role="alert">{{ error() }}</p>
      }
      <div class="actions">
        <button type="button" class="k-btn k-btn-secondary" (click)="closed.emit()">Cancel</button>
        <button type="submit" class="k-btn k-btn-primary" [disabled]="saving() || loading()">
          {{ action === 'checkout' ? 'Check out' : 'Check in' }}
        </button>
      </div>
    </form>
  `,
  styles: [
    `
      form {
        display: grid;
        gap: 0.9rem;
        padding-top: 0.7rem;
      }
      select {
        background: var(--kestrel-surface);
        border: 1px solid var(--kestrel-border);
        padding: 0.4rem 0.65rem;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.6rem;
      }
      [role='alert'] {
        color: var(--kestrel-danger);
      }
    `,
  ],
})
export class AssetLifecycleComponent implements OnInit {
  @Input({ required: true }) asset!: DataGridRow;
  @Input({ required: true }) action!: 'checkout' | 'checkin';
  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<string>();

  private readonly api = inject(InventoryApi);
  private readonly router = inject(Router);
  readonly checkoutFields = [
    field('expected_checkin', 'Expected return date', 'date'),
    field('name', 'Asset name'),
    field('note', 'Checkout note', 'textarea'),
    field('sign_in_place', 'Have the assignee sign here', 'boolean'),
  ];
  readonly checkinFields = [
    {
      ...reference('location_id', 'Return location', 'locations'),
      optionsPath: '/hardware/targets/location',
    },
    reference('status_id', 'New status', 'statuslabels'),
    field('name', 'Asset name'),
    field('clear_name', 'Clear asset name', 'boolean'),
    field('update_default_location', 'Update home location', 'boolean'),
    field('note', 'Check-in note', 'textarea'),
  ];
  readonly form = new FormGroup<Record<string, FormControl>>({});
  readonly custom = new FormRecord<FormControl>({});
  readonly fields = signal<InventoryCustomField[]>([]);
  readonly values = signal<Record<string, unknown>>({});
  readonly targets = signal<AsyncSelectOption[]>([]);
  readonly error = signal('');
  readonly saving = signal(false);
  readonly loading = signal(false);
  private targetRequest = 0;

  get assetCompanyId(): number | null | undefined {
    const company = this.asset['company_id'];
    return company === null || typeof company === 'number' ? company : undefined;
  }

  ngOnInit(): void {
    if (this.action === 'checkout') {
      this.form.addControl('target_type', new FormControl('user', Validators.required));
      this.form.addControl('target_id', new FormControl(null, Validators.required));
      void this.searchTargets('');
    }
    for (const item of this.action === 'checkout' ? this.checkoutFields : this.checkinFields) {
      this.form.addControl(item.key, new FormControl(item.type === 'boolean' ? false : null));
    }
    void this.loadFields();
  }

  targetChanged(): void {
    this.form.controls['target_id']?.reset();
    this.targets.set([]);
    void this.searchTargets('');
  }

  async searchTargets(search: string) {
    const request = ++this.targetRequest;
    const type = this.form.controls['target_type']?.value as CheckoutTargetType;
    try {
      const data = await this.api.read<SelectlistResponse>(`/hardware/targets/${type}`, {
        search,
        ...companyQuery(this.assetCompanyId),
      });
      if (request !== this.targetRequest) return;
      const candidates = data.results.filter(({ id }) => type !== 'asset' || id !== this.asset.id);
      this.targets.set(candidates.map(({ id, text, disabled }) => ({ id, text, disabled })));
    } catch (error) {
      if (request === this.targetRequest) this.error.set(inventoryError(error));
    }
  }

  private async loadFields() {
    const id = this.asset.id;
    const model = this.asset['model_id'];
    if (typeof id !== 'number' || typeof model !== 'number') return;
    this.loading.set(true);
    try {
      const [data, current] = await Promise.all([
        this.api.read<{ fields: InventoryCustomField[] }>(`/hardware/form/${model}`, {
          mode: this.action,
        }),
        this.api.read<{ custom_fields: Record<string, { field: string; value: unknown }> }>(
          `/hardware/${id}`,
        ),
      ]);
      this.fields.set(data.fields);
      this.values.set(
        Object.fromEntries(
          Object.values(current.custom_fields).map(({ field, value }) => [field, value]),
        ),
      );
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.loading.set(false);
    }
  }

  async submit() {
    if (this.saving() || this.loading()) return;
    if (this.form.invalid || this.custom.invalid) {
      this.error.set('Enter all required values.');
      return;
    }
    this.saving.set(true);
    this.error.set('');
    try {
      const input = Object.fromEntries(
        Object.entries(this.form.controls)
          .filter(([key, control]) => control.dirty || key === 'target_type' || key === 'target_id')
          .map(([key, control]) => [
            key,
            control.value === '' && key !== 'name' ? null : control.value,
          ]),
      );
      const custom = customFieldChanges(this.custom, this.fields());
      if (Object.keys(custom).length) input['custom_fields'] = custom;
      const result = await this.api.write<{ acceptance_id?: number; sign_in_place?: boolean }>(
        'POST',
        `/hardware/${this.asset.id}/${this.action}`,
        input,
      );
      this.saved.emit(typeof result.messages === 'string' ? result.messages : 'Changes saved.');
      if (result.payload?.sign_in_place && result.payload.acceptance_id) {
        await this.router.navigate(['/account/accept', result.payload.acceptance_id]);
      }
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.saving.set(false);
    }
  }
}

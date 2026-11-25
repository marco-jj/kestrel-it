import { Component, EventEmitter, Input, OnChanges, Output, inject, signal } from '@angular/core';
import { FormControl, FormRecord, ReactiveFormsModule } from '@angular/forms';
import type { InventoryCustomField } from '@kestrel-it/shared';
import type { DataGridRow } from '../../shared/ui/data-grid.component.js';
import {
  CustomFieldFormSectionComponent,
  customFieldChanges,
} from './custom-field-form-section.component.js';
import { field, reference } from './directory-ui.js';
import { InventoryApi, inventoryError } from './inventory-api.js';
import { InventoryFormFieldsComponent } from './inventory-form-fields.component.js';
import { inventoryForm } from './phase-three-ui.js';

@Component({
  selector: 'kestrel-asset-audit-form',
  standalone: true,
  imports: [ReactiveFormsModule, CustomFieldFormSectionComponent, InventoryFormFieldsComponent],
  template: `
    @if (asset) {
      <p>{{ asset['asset_tag'] }} {{ asset['name'] }}</p>
    } @else {
      <p>{{ ids.length }} assets selected</p>
    }
    <form [formGroup]="form" (ngSubmit)="save()">
      <kestrel-inventory-form-fields [form]="form" [fields]="fields" [companyId]="companyId" />
      @if (customFields().length) {
        <kestrel-custom-field-form-section
          [form]="custom"
          [fields]="customFields()"
          [values]="values()"
        />
      }
      <label class="photo"
        >Audit photo <input type="file" accept="image/png,image/jpeg" (change)="pick($event)"
      /></label>
      @if (error()) {
        <p role="alert">{{ error() }}</p>
      }
      @if (results().length) {
        <ul aria-label="Audit results">
          @for (row of results(); track row.id) {
            <li>
              #{{ row.id }} · {{ row.status === 'success' ? 'Recorded' : failure(row.messages) }}
            </li>
          }
        </ul>
      }
      <div class="actions">
        <button type="button" class="k-btn k-btn-secondary" (click)="closed.emit()">Close</button>
        <button type="submit" class="k-btn k-btn-primary" [disabled]="busy() || !!results().length">
          Record audit
        </button>
      </div>
    </form>
  `,
  styles: [
    `
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.65rem;
        margin-top: 1rem;
      }
      .photo {
        display: grid;
        gap: 0.35rem;
        margin-top: 0.9rem;
      }
      li {
        margin-bottom: 0.35rem;
      }
      [role='alert'] {
        color: var(--kestrel-danger);
      }
    `,
  ],
})
export class AssetAuditFormComponent implements OnChanges {
  @Input() asset?: DataGridRow;
  @Input() ids: number[] = [];
  @Output() saved = new EventEmitter<string>();
  @Output() closed = new EventEmitter<void>();
  private readonly api = inject(InventoryApi);
  readonly fields = [
    field('next_audit_date', 'Next audit date', 'date'),
    reference('location_id', 'Observed location', 'locations'),
    field('update_location', 'Update asset location', 'boolean'),
    field('clear_name', 'Clear asset name', 'boolean'),
    field('note', 'Audit notes', 'textarea'),
  ];
  readonly form = inventoryForm(this.fields);
  readonly custom = new FormRecord<FormControl>({});
  readonly customFields = signal<InventoryCustomField[]>([]);
  readonly values = signal<Record<string, unknown>>({});
  readonly error = signal('');
  readonly busy = signal(false);
  readonly results = signal<Array<{ id: number; status: string; messages: unknown }>>([]);
  private photo?: File;
  private sequence = 0;

  get companyId() {
    const id = this.asset?.['company_id'];
    return id === null || typeof id === 'number' ? id : undefined;
  }

  ngOnChanges(): void {
    const seq = ++this.sequence;
    this.customFields.set([]);
    this.values.set({});
    this.results.set([]);
    this.error.set('');
    this.photo = undefined;
    if (typeof this.asset?.['model_id'] === 'number') void this.load(seq, this.asset['model_id']);
  }

  private async load(seq: number, model: number) {
    this.busy.set(true);
    try {
      const options = await this.api.read<{ fields: InventoryCustomField[] }>(
        `/hardware/form/${model}`,
        { mode: 'audit' },
      );
      if (seq !== this.sequence) return;
      const existing = this.asset?.['custom_fields'] as
        Record<string, { field: string; value: unknown }> | undefined;
      this.values.set(
        Object.fromEntries(
          Object.values(existing ?? {}).map(({ field: name, value }) => [name, value]),
        ),
      );
      this.customFields.set(options.fields);
    } catch (error) {
      if (seq === this.sequence) this.error.set(inventoryError(error));
    } finally {
      if (seq === this.sequence) this.busy.set(false);
    }
  }

  pick(event: Event) {
    this.photo = (event.target as HTMLInputElement).files?.[0];
  }

  failure(value: unknown) {
    return typeof value === 'string'
      ? value
      : Object.values(value ?? {})
          .flat()
          .join(' ');
  }

  async save() {
    if (this.busy()) return;
    if (this.form.invalid || this.custom.invalid) {
      this.form.markAllAsTouched();
      this.custom.markAllAsTouched();
      this.error.set('Check the audit fields before recording.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    const bulk = !this.asset;
    const endpoint = bulk ? '/hardware/audit/bulk' : `/hardware/${this.asset!.id}/audit`;
    const payload = {
      ...this.form.getRawValue(),
      ...(bulk ? { ids: this.ids } : {}),
      custom_fields: customFieldChanges(this.custom, this.customFields()),
    };
    const formData = this.photo ? new FormData() : undefined;
    formData?.append('payload', JSON.stringify(payload));
    if (this.photo) formData?.append('photo', this.photo);
    try {
      if (bulk) {
        const response = await this.api.command<{
          messages: string;
          results: Array<{ id: number; status: string; messages: unknown }>;
        }>(endpoint, formData ?? payload);
        this.results.set(response.results);
        if (response.results.every(({ status }) => status === 'success'))
          this.saved.emit(response.messages);
      } else {
        await this.api.write('POST', endpoint, formData ?? payload);
        this.saved.emit('Audit recorded.');
      }
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.busy.set(false);
    }
  }
}

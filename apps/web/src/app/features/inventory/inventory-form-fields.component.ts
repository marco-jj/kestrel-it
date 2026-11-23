import { Component, Input, type OnChanges, type OnDestroy, inject, signal } from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ALL_PERMISSIONS } from '@kestrel-it/shared';
import type { Subscription } from 'rxjs';
import {
  KestrelAsyncSelectComponent,
  type AsyncSelectOption,
} from '../../shared/ui/async-select.component.js';
import { InventoryApi, inventoryError } from './inventory-api.js';
import type { InventoryField } from './directory-ui.js';

const companyScopedResources = new Set(['locations', 'departments', 'users']);

@Component({
  selector: 'kestrel-inventory-form-fields',
  standalone: true,
  imports: [ReactiveFormsModule, KestrelAsyncSelectComponent],
  template: `
    <div [formGroup]="form" class="field-grid">
      @for (field of fields; track field.key) {
        @switch (field.type) {
          @case ('reference') {
            <kestrel-async-select
              [label]="field.label"
              [options]="options()[field.key] ?? []"
              [formControlName]="field.key"
              [companyId]="companyFor(field)"
              [allowQuickCreate]="false"
              (searchChanged)="loadOptions(field, $event)"
            />
          }
          @case ('ids') {
            <div>
              <kestrel-async-select
                [label]="field.label"
                [options]="options()[field.key] ?? []"
                [companyId]="companyFor(field)"
                [allowQuickCreate]="false"
                (searchChanged)="loadOptions(field, $event)"
                (selectionChanged)="addId(field, $event)"
              />
              @for (id of form.get(field.key)?.value ?? []; track id) {
                <button type="button" class="k-btn k-btn-secondary" (click)="removeId(field, id)">
                  {{ optionLabel(field, id) }} ×
                </button>
              }
            </div>
          }
          @case ('permissions') {
            <details>
              <summary>{{ field.label }}</summary>
              @for (permission of permissions; track permission) {
                <label
                  >{{ permission }}
                  <select
                    [value]="form.get(field.key)?.value?.[permission] ?? 0"
                    (change)="setPermission(field, permission, $any($event.target).value)"
                  >
                    <option value="0">Inherit</option>
                    <option value="1">Grant</option>
                    <option value="-1">Deny</option>
                  </select>
                </label>
              }
            </details>
          }
          @case ('boolean') {
            <label class="checkbox"
              ><input type="checkbox" [formControlName]="field.key" /> {{ field.label }}</label
            >
          }
          @case ('textarea') {
            <label
              >{{ field.label }}<textarea [formControlName]="field.key" rows="4"></textarea>
            </label>
          }
          @case ('enum') {
            <label
              >{{ field.label }}
              <select [formControlName]="field.key">
                @if (!field.required) {
                  <option [ngValue]="null">No value</option>
                }
                @for (option of field.options; track option) {
                  <option [value]="option">{{ option }}</option>
                }
              </select>
            </label>
          }
          @default {
            <label
              >{{ field.label }}
              <input
                [type]="
                  field.type === 'number' || field.type === 'password' || field.type === 'date'
                    ? field.type
                    : 'text'
                "
                [formControlName]="field.key"
                [required]="field.required ?? false"
              />
            </label>
          }
        }
      }
    </div>
    @if (optionsError()) {
      <p role="status">{{ optionsError() }}</p>
    }
  `,
  styles: [
    `
      .field-grid {
        display: grid;
        gap: 1rem;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
      }
      label:not(.checkbox) {
        display: grid;
        gap: 0.4rem;
      }
      .checkbox {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        min-height: 2.25rem;
      }
      input:not([type='checkbox']),
      textarea,
      select {
        color: var(--kestrel-ink);
        background: var(--kestrel-surface);
        border: 1px solid var(--kestrel-border);
        border-radius: 0.5rem;
        padding: 0.5rem 0.65rem;
        min-height: 2.25rem;
        width: 100%;
      }
      details label {
        margin: 0.5rem 0;
      }
    `,
  ],
})
export class InventoryFormFieldsComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) form!: FormGroup;
  @Input({ required: true }) fields: InventoryField[] = [];
  @Input() companyId?: number | null;

  private readonly api = inject(InventoryApi);
  private readonly requests = new Map<string, number>();
  private readonly searches = new Map<string, string>();
  private readonly activeCompany = signal<number | null | undefined>(undefined);
  private companyChanges?: Subscription;
  readonly options = signal<Record<string, AsyncSelectOption[]>>({});
  readonly optionsError = signal('');
  readonly permissions = ALL_PERMISSIONS;

  ngOnChanges(): void {
    this.companyChanges?.unsubscribe();
    this.invalidateOptions();
    this.searches.clear();
    const company = this.form.get('company_id') ?? this.form.get('company_ids');
    this.setActiveCompany(company?.value);
    this.companyChanges = company?.valueChanges.subscribe((value: unknown) => {
      const previous = this.activeCompany();
      this.setActiveCompany(value);
      if (previous === this.activeCompany()) return;
      for (const field of this.fields.filter((item) => this.isCompanyScoped(item))) {
        this.options.update((options) => ({ ...options, [field.key]: [] }));
        void this.loadOptions(field, this.searches.get(field.key) ?? '');
      }
    });
    for (const field of this.fields) {
      if (field.resource) void this.loadOptions(field, '');
    }
  }

  ngOnDestroy(): void {
    this.companyChanges?.unsubscribe();
    this.invalidateOptions();
  }

  private invalidateOptions(): void {
    for (const [key, request] of this.requests) this.requests.set(key, request + 1);
    this.options.set({});
    this.optionsError.set('');
  }

  private setActiveCompany(value: unknown): void {
    if (this.companyId !== undefined) {
      this.activeCompany.set(this.companyId);
      return;
    }
    const selected = Array.isArray(value) && value.length === 1 ? value[0] : value;
    this.activeCompany.set(typeof selected === 'number' ? selected : undefined);
  }

  private isCompanyScoped(field: InventoryField): boolean {
    return !!field.resource && companyScopedResources.has(field.resource);
  }

  companyFor(field: InventoryField): number | null | undefined {
    return this.isCompanyScoped(field) ? this.activeCompany() : undefined;
  }

  async loadOptions(field: InventoryField, search: string) {
    if (!field.resource) return;
    this.searches.set(field.key, search);
    const request = (this.requests.get(field.key) ?? 0) + 1;
    this.requests.set(field.key, request);
    try {
      const response = await this.api.options(field.resource, search, {
        companyId: this.companyFor(field),
        path: field.optionsPath,
      });
      if (this.requests.get(field.key) !== request) return;
      this.options.update((current) => ({
        ...current,
        [field.key]: response.results.map((r) => ({
          id: r.id,
          text: r.text,
          disabled: r.disabled,
        })),
      }));
    } catch (error) {
      if (this.requests.get(field.key) === request) this.optionsError.set(inventoryError(error));
    }
  }

  optionLabel(field: InventoryField, id: number) {
    return this.options()[field.key]?.find((option) => option.id === id)?.text ?? `#${id}`;
  }

  addId(field: InventoryField, option: AsyncSelectOption | null): void {
    const control = this.form.get(field.key);
    if (!control || typeof option?.id !== 'number') return;
    control.setValue([...new Set<number>([...(control.value ?? []), option.id])]);
    control.markAsDirty();
  }

  removeId(field: InventoryField, id: number): void {
    const control = this.form.get(field.key);
    control?.setValue(control.value.filter((entry: number) => entry !== id));
    control?.markAsDirty();
  }

  setPermission(field: InventoryField, permission: string, value: string): void {
    const control = this.form.get(field.key);
    control?.setValue({ ...control.value, [permission]: Number(value) });
    control?.markAsDirty();
  }
}

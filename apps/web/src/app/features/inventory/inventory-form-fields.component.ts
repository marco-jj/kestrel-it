import { Component, Input, inject, signal } from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ALL_PERMISSIONS } from '@kestrel-it/shared';
import {
  KestrelAsyncSelectComponent,
  type AsyncSelectOption,
} from '../../shared/ui/async-select.component.js';
import { InventoryApi, inventoryError } from './inventory-api.js';
import type { InventoryField } from './directory-ui.js';

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
              [allowQuickCreate]="false"
              (searchChanged)="loadOptions(field, $event)"
            />
          }
          @case ('ids') {
            <div>
              <kestrel-async-select
                [label]="field.label"
                [options]="options()[field.key] ?? []"
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
        color: var(--k-text);
        background: var(--k-surface);
        border: 1px solid var(--k-border);
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
export class InventoryFormFieldsComponent {
  @Input({ required: true }) form!: FormGroup;
  @Input({ required: true }) set fields(value: InventoryField[]) {
    this.fieldList = value;
    for (const field of value) {
      if (field.resource) void this.loadOptions(field, '');
    }
  }
  get fields(): InventoryField[] {
    return this.fieldList;
  }

  private readonly api = inject(InventoryApi);
  private readonly requests = new Map<string, number>();
  private fieldList: InventoryField[] = [];
  readonly options = signal<Record<string, AsyncSelectOption[]>>({});
  readonly optionsError = signal('');
  readonly permissions = ALL_PERMISSIONS;

  async loadOptions(field: InventoryField, search: string) {
    if (!field.resource) return;
    const request = (this.requests.get(field.key) ?? 0) + 1;
    this.requests.set(field.key, request);
    try {
      const response = await this.api.options(field.resource, search);
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

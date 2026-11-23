import { Component, Input, OnChanges, inject } from '@angular/core';
import { FormControl, FormRecord, ReactiveFormsModule, Validators } from '@angular/forms';
import {
  normalizeFormatLabel,
  parseFieldValuesOptions,
  type InventoryCustomField,
} from '@kestrel-it/shared';

import { AuthStore } from '../../core/auth/auth.store.js';

@Component({
  selector: 'kestrel-custom-field-form-section',
  standalone: true,
  imports: [ReactiveFormsModule],
  template: `
    @if (fields.length) {
      <fieldset [formGroup]="form">
        <legend>Custom fields</legend>
        @for (field of fields; track field.id) {
          <div class="custom-field">
            <label [attr.for]="'custom-' + field.id">{{ field.name }}</label>
            @if (field.help_text) {
              <small>{{ field.help_text }}</small>
            }
            @if (isMasked(field)) {
              <input [id]="'custom-' + field.id" [value]="'ENCRYPTED'" readonly />
            } @else {
              @switch (field.element) {
                @case ('textarea') {
                  <textarea
                    [id]="'custom-' + field.id"
                    [formControlName]="field.db_column"
                    rows="3"
                  ></textarea>
                }
                @case ('listbox') {
                  <select [id]="'custom-' + field.id" [formControlName]="field.db_column">
                    <option [ngValue]="null">No value</option>
                    @for (option of options(field.field_values); track option.value) {
                      <option [value]="option.value">{{ option.label }}</option>
                    }
                  </select>
                }
                @case ('radio') {
                  <div [id]="'custom-' + field.id">
                    @for (option of options(field.field_values); track option.value) {
                      <label
                        ><input
                          type="radio"
                          [formControlName]="field.db_column"
                          [value]="option.value"
                        />
                        {{ option.label }}</label
                      >
                    }
                  </div>
                }
                @case ('checkbox') {
                  <div [id]="'custom-' + field.id">
                    @for (option of options(field.field_values); track option.value) {
                      <label
                        ><input
                          type="checkbox"
                          [checked]="checked(field.db_column, option.value)"
                          (change)="
                            toggle(field.db_column, option.value, $any($event.target).checked)
                          "
                        />
                        {{ option.label }}</label
                      >
                    }
                  </div>
                }
                @default {
                  <input
                    [id]="'custom-' + field.id"
                    [type]="inputType(field)"
                    [formControlName]="field.db_column"
                  />
                }
              }
            }
          </div>
        }
      </fieldset>
    }
  `,
  styles: [
    `
      fieldset {
        border: 1px solid var(--kestrel-border);
        border-radius: 0.5rem;
        padding: 0.85rem;
        display: grid;
        gap: 0.7rem;
        margin-block: 1rem;
      }
      legend {
        font-weight: 600;
        padding-inline: 0.35rem;
      }
      .custom-field {
        display: grid;
        gap: 0.2rem;
      }
      .custom-field div {
        display: flex;
        flex-wrap: wrap;
        gap: 0.8rem;
      }
      input:not([type='checkbox']):not([type='radio']),
      textarea,
      select {
        color: var(--kestrel-ink);
        background: var(--kestrel-surface);
        border: 1px solid var(--kestrel-border);
        border-radius: 0.4rem;
        padding: 0.45rem 0.65rem;
        width: 100%;
      }
    `,
  ],
})
export class CustomFieldFormSectionComponent implements OnChanges {
  @Input({ required: true }) form!: FormRecord<FormControl>;
  @Input({ required: true }) fields: InventoryCustomField[] = [];
  @Input() values: Record<string, unknown> = {};
  @Input() defaultsOnly = false;
  private readonly auth = inject(AuthStore);
  readonly options = parseFieldValuesOptions;

  ngOnChanges(): void {
    if (!this.form) return;
    for (const key of Object.keys(this.form.controls)) this.form.removeControl(key);
    for (const field of this.fields) {
      const value = this.values[field.db_column] ?? (field.element === 'checkbox' ? [] : null);
      const initial =
        field.element === 'datetime_picker' && typeof value === 'string'
          ? value.replace(' ', 'T')
          : value;
      this.form.addControl(
        field.db_column,
        new FormControl(
          { value: initial, disabled: this.isMasked(field) },
          field.required && !this.defaultsOnly ? [Validators.required] : [],
        ),
      );
    }
  }

  isMasked(field: InventoryCustomField): boolean {
    const user = this.auth.currentUser();
    const allowed =
      user?.isSuperUser || user?.keyPermissions?.['assets.view.encrypted_custom_fields'];
    return !allowed && field.field_encrypted && this.values[field.db_column] === 'ENCRYPTED';
  }

  inputType(field: InventoryCustomField) {
    if (field.element === 'date_picker') return 'date';
    if (field.element === 'datetime_picker') return 'datetime-local';
    const format = normalizeFormatLabel(field.format);
    return format === 'EMAIL' ? 'email' : format === 'URL' ? 'url' : 'text';
  }

  checked(key: string, value: string) {
    const current: unknown = this.form.controls[key]?.value;
    return Array.isArray(current) && current.includes(value);
  }

  toggle(key: string, value: string, checked: boolean): void {
    const control = this.form.controls[key];
    if (!control) return;
    const current: string[] = Array.isArray(control.value) ? control.value : [];
    control.setValue(
      checked ? [...new Set([...current, value])] : current.filter((entry) => entry !== value),
    );
    control.markAsDirty();
  }
}

export function customFieldChanges(form: FormRecord<FormControl>, fields: InventoryCustomField[]) {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const control = form.controls[field.db_column];
    if (!control?.dirty || control.disabled) continue;
    const value: unknown = control.value;
    if (field.element === 'datetime_picker' && typeof value === 'string' && value) {
      const formatted = value.replace('T', ' ');
      values[field.db_column] = formatted.length === 16 ? formatted + ':00' : formatted;
    } else {
      values[field.db_column] = value === '' ? null : value;
    }
  }
  return values;
}

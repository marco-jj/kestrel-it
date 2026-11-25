import { Component, Input, forwardRef, signal } from '@angular/core';
import { NG_VALIDATORS, NG_VALUE_ACCESSOR, type ControlValueAccessor, type Validator } from '@angular/forms';
import { formatDisplayDate, parseDisplayDate } from './display-date.js';

@Component({
  selector: 'kestrel-date-input',
  standalone: true,
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => DateInputComponent), multi: true },
    { provide: NG_VALIDATORS, useExisting: forwardRef(() => DateInputComponent), multi: true },
  ],
  template: `
    <span class="date-control">
      <input class="k-input" type="text" [id]="inputId" [attr.aria-label]="label"
        [placeholder]="hint" [value]="text()" [disabled]="disabled()"
        [attr.aria-invalid]="invalid() || null" [attr.aria-describedby]="invalid() ? errorId : null"
        (input)="edit($any($event.target).value)" (blur)="touch()" />
      <span class="picker-button">
        <span aria-hidden="true">▦</span>
        <input class="picker" [type]="withTime ? 'datetime-local' : 'date'"
          [value]="iso()" [disabled]="disabled()" [attr.aria-label]="'Open date picker' + (label ? ' for ' + label : '')"
          (change)="choose($any($event.target).value)" (blur)="touch()" />
      </span>
    </span>
    @if (invalid()) {
      <small class="k-field-error" [id]="errorId" aria-live="polite">Enter a valid date in {{ hint }} format.</small>
    }
  `,
  styles: [`
    :host { display: grid; gap: 0.25rem; min-width: 0; }
    .date-control { display: flex; align-items: center; gap: 0.25rem; }
    .k-input { flex: 1; min-width: 0; }
    .picker-button {
      position: relative;
      display: grid;
      place-items: center;
      min-width: 2.25rem;
      min-height: 2.25rem;
      border: 1px solid var(--kestrel-border);
      border-radius: var(--kestrel-radius-sm);
    }
    .picker-button:focus-within { outline: 2px solid var(--kestrel-accent); }
    .picker { position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer; }
    .picker::-webkit-calendar-picker-indicator {
      position: absolute; inset: 0; width: auto; height: auto; padding: 0; cursor: pointer;
    }
  `],
})
export class DateInputComponent implements ControlValueAccessor, Validator {
  private static nextId = 0;
  readonly errorId = `date-input-${DateInputComponent.nextId++}-error`;
  @Input() inputId?: string;
  @Input() label?: string;
  @Input() withTime = false;
  readonly text = signal('');
  readonly iso = signal('');
  readonly invalid = signal(false);
  readonly disabled = signal(false);
  private onChange: (value: string | null) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  get hint(): string {
    return this.withTime ? 'dd/MM/yyyy HH:mm' : 'dd/MM/yyyy';
  }

  writeValue(value: unknown): void {
    const text = formatDisplayDate(value, this.withTime) ?? '';
    this.text.set(text);
    this.iso.set(parseDisplayDate(text, this.withTime) ?? '');
    this.invalid.set(false);
  }

  registerOnChange(callback: (value: string | null) => void): void {
    this.onChange = callback;
  }

  registerOnTouched(callback: () => void): void {
    this.onTouched = callback;
  }

  setDisabledState(disabled: boolean): void {
    this.disabled.set(disabled);
  }

  validate() {
    return this.invalid() ? { dateFormat: true } : null;
  }

  edit(text: string): void {
    const iso = parseDisplayDate(text, this.withTime);
    this.text.set(text);
    this.iso.set(iso ?? '');
    this.invalid.set(Boolean(text.trim()) && iso === null);
    this.onChange(iso);
  }

  choose(value: string): void {
    this.writeValue(value);
    this.onChange(this.iso() || null);
    this.touch();
  }

  touch(): void {
    this.onTouched();
  }
}

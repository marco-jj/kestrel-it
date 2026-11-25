import { Component, ElementRef, HostListener, Input, forwardRef, inject, signal, type OnDestroy } from '@angular/core';
import { NG_VALUE_ACCESSOR, type ControlValueAccessor } from '@angular/forms';
import type { DataGridRow } from '../../shared/ui/data-grid.component.js';
import { InventoryApi } from './inventory-api.js';

export function suggestAssetTags(rows: readonly DataGridRow[], query: string): string[] {
  const search = query.trim().toLowerCase();
  if (!search) return [];
  return [...new Set(rows.map((row) => row['asset_tag']).filter(
    (tag): tag is string => typeof tag === 'string' && tag.toLowerCase().includes(search),
  ))].slice(0, 8);
}

@Component({
  selector: 'kestrel-asset-tag-field',
  standalone: true,
  providers: [{
    provide: NG_VALUE_ACCESSOR,
    useExisting: forwardRef(() => AssetTagFieldComponent),
    multi: true,
  }],
  template: `
    @if (committed()) {
      <span>{{ label }}</span>
      <span class="k-tag k-mono">
        {{ value() }}
        <button type="button" [attr.aria-label]="'Remove tag ' + value()" [disabled]="disabled()" (click)="remove()">×</button>
      </span>
    } @else {
      <label>
        {{ label }}
        <input class="k-input" type="text" maxlength="255" autocomplete="off"
          [value]="value()" [disabled]="disabled()"
          (input)="edit($any($event.target).value)" (keydown.enter)="onEnter($event)"
          (keydown.escape)="closeSuggestions()" />
      </label>
      @if (suggestions().length) {
        <ul class="suggestions" aria-label="Suggested asset tags">
          @for (tag of suggestions(); track tag) {
            <li><button type="button" (click)="commit(tag)">{{ tag }}</button></li>
          }
        </ul>
      }
    }
  `,
  styles: [`
    :host { position: relative; display: grid; gap: 0.4rem; align-content: start; }
    label { display: grid; gap: 0.4rem; }
    .k-tag { justify-self: start; }
    .k-tag button { padding-inline: 0.3rem; cursor: pointer; }
    .suggestions {
      position: absolute; top: 100%; inset-inline: 0; z-index: 40;
      margin: 0; padding: 0.25rem; list-style: none;
      border: 1px solid var(--kestrel-border-strong);
      border-radius: var(--kestrel-radius-md); background: var(--kestrel-surface);
      box-shadow: var(--kestrel-shadow-lg);
    }
    .suggestions button { width: 100%; text-align: start; padding: 0.35rem 0.55rem; cursor: pointer; }
    .suggestions button:hover, .suggestions button:focus-visible { background: var(--kestrel-accent-subtle); }
  `],
})
export class AssetTagFieldComponent implements ControlValueAccessor, OnDestroy {
  @Input() label = 'Asset tag';
  @Input() suggest = false;
  @Input() set companyId(value: number | undefined) {
    if (this.company === value) return;
    this.company = value;
    this.closeSuggestions();
  }

  readonly value = signal('');
  readonly committed = signal(false);
  readonly disabled = signal(false);
  readonly suggestions = signal<string[]>([]);

  private readonly api = inject(InventoryApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private company?: number;
  private request = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private change: (value: string | null) => void = () => undefined;
  private touched: () => void = () => undefined;

  writeValue(value: string | null): void {
    this.value.set(value ?? '');
    this.committed.set(Boolean(value));
    this.closeSuggestions();
  }

  registerOnChange(callback: (value: string | null) => void): void {
    this.change = callback;
  }

  registerOnTouched(callback: () => void): void {
    this.touched = callback;
  }

  setDisabledState(disabled: boolean): void {
    this.disabled.set(disabled);
    if (disabled) this.closeSuggestions();
  }

  edit(value: string): void {
    this.value.set(value);
    const query = value.trim();
    this.change(query || null);
    this.closeSuggestions();
    if (this.suggest && query) {
      const request = this.request;
      this.timer = setTimeout(() => void this.loadSuggestions(query, request), 200);
    }
  }

  commit(raw: string): void {
    const tag = raw.trim();
    if (tag !== this.value().trim()) this.change(tag || null);
    this.writeValue(tag || null);
    this.touched();
  }

  remove(): void {
    this.writeValue(null);
    this.change(null);
    this.touched();
  }

  onEnter(event: KeyboardEvent): void {
    if (!this.value().trim() || event.isComposing) return;
    event.preventDefault();
    this.commit(this.value());
  }

  @HostListener('focusout', ['$event'])
  onFocusOut(event: FocusEvent): void {
    if (!this.committed() && !this.host.nativeElement.contains(event.relatedTarget as Node | null)) {
      this.commit(this.value());
    }
  }

  closeSuggestions(): void {
    this.request++;
    clearTimeout(this.timer);
    this.suggestions.set([]);
  }

  ngOnDestroy(): void {
    this.closeSuggestions();
  }

  private async loadSuggestions(search: string, request: number): Promise<void> {
    try {
      const result = await this.api.records('/hardware', {
        search, limit: 20, ...(this.company === undefined ? {} : { company_id: this.company }),
      });
      if (request === this.request) this.suggestions.set(suggestAssetTags(result.rows, search));
    } catch {
      // Asset tags can still be entered when suggestions are unavailable.
    }
  }
}

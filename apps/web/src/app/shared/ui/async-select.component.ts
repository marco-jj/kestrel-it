import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  Input,
  Output,
  computed,
  forwardRef,
  signal,
  type OnChanges,
} from '@angular/core';
import { NG_VALUE_ACCESSOR, type ControlValueAccessor } from '@angular/forms';

export interface AsyncSelectOption {
  id: number | string;
  text: string;
  image?: string | null;
  companyId?: number | null;
  statusMeta?: string;
}

export function filterAsyncSelectOptions(
  options: readonly AsyncSelectOption[],
  query: string,
  companyId?: number | null,
  includeNullCompany = true,
): AsyncSelectOption[] {
  const normalized = query.trim().toLowerCase();

  return options.filter((opt) => {
    if (!isVisibleInCompany(opt, companyId, includeNullCompany)) return false;

    if (normalized) {
      return opt.text.toLowerCase().includes(normalized);
    }

    return true;
  });
}

function isVisibleInCompany(
  option: AsyncSelectOption,
  companyId: number | null | undefined,
  includeNullCompany: boolean,
): boolean {
  const optionCompany = option.companyId ?? null;
  return companyId == null || optionCompany === companyId ||
    (includeNullCompany && optionCompany === null);
}

@Component({
  selector: 'kestrel-async-select',
  standalone: true,
  imports: [CommonModule],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => KestrelAsyncSelectComponent),
      multi: true,
    },
  ],
  template: `
    <div class="async-select" [class.disabled]="disabledSignal()">
      @if (label) {
        <span class="k-label">{{ label }}</span>
      }

      <div class="control-row">
        <div class="input-trigger-wrap">
          <input
            type="text"
            class="k-input"
            [placeholder]="placeholder"
            [value]="displayInputValue()"
            [disabled]="disabledSignal()"
            (focus)="openDropdown()"
            (input)="onSearchChange($any($event.target).value)"
            [attr.aria-expanded]="isOpen()"
            role="combobox"
          />
          @if (selectedOption() && !disabledSignal()) {
            <button
              type="button"
              class="clear-btn k-btn k-btn-ghost"
              (click)="clearSelection()"
              aria-label="Clear selection"
            >
              ×
            </button>
          }
        </div>

        @if (allowQuickCreate) {
          <button
            type="button"
            class="k-btn k-btn-secondary quick-btn"
            [disabled]="disabledSignal()"
            (click)="triggerQuickCreate()"
          >
            + {{ quickCreateLabel }}
          </button>
        }
      </div>

      @if (isOpen()) {
        <div class="dropdown-panel" role="listbox">
          @for (opt of filteredOptions(); track opt.id) {
            <button
              type="button"
              class="dropdown-option"
              [class.selected]="opt.id === selectedId()"
              role="option"
              [attr.aria-selected]="opt.id === selectedId()"
              (click)="selectOption(opt)"
            >
              <span>{{ opt.text }}</span>
              @if (opt.companyId !== null && opt.companyId !== undefined) {
                <span class="k-mono opt-meta">CO#{{ opt.companyId }}</span>
              }
            </button>
          } @empty {
            <div class="dropdown-empty">No matching records for active company scope.</div>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      .async-select {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }
      .control-row {
        display: flex;
        gap: 0.5rem;
        align-items: center;
      }
      .input-trigger-wrap {
        position: relative;
        flex: 1;
      }
      .clear-btn {
        position: absolute;
        right: 4px;
        top: 50%;
        transform: translateY(-50%);
        min-height: 28px;
        padding: 0 0.45rem;
      }
      .quick-btn {
        flex-shrink: 0;
      }
      .dropdown-panel {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        right: 0;
        z-index: 40;
        max-height: 230px;
        overflow-y: auto;
        background: var(--kestrel-surface);
        border: 1px solid var(--kestrel-border-strong);
        border-radius: var(--kestrel-radius-md);
        box-shadow: var(--kestrel-shadow-lg);
        padding: 0.3rem;
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
      }
      .dropdown-option {
        width: 100%;
        border: 0;
        background: transparent;
        color: var(--kestrel-ink);
        padding: 0.45rem 0.6rem;
        border-radius: var(--kestrel-radius-sm);
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-family: inherit;
        font-size: 0.84rem;
        text-align: left;
        cursor: pointer;
      }
      .dropdown-option:hover,
      .dropdown-option.selected {
        background: var(--kestrel-accent-subtle);
      }
      .opt-meta {
        font-size: 0.7rem;
        color: var(--kestrel-muted);
      }
      .dropdown-empty {
        padding: 0.75rem;
        text-align: center;
        font-size: 0.8rem;
        color: var(--kestrel-muted);
      }
    `,
  ],
})
export class KestrelAsyncSelectComponent implements ControlValueAccessor, OnChanges {
  readonly optionsSignal = signal<readonly AsyncSelectOption[]>([]);
  readonly companyIdSignal = signal<number | null>(null);
  readonly includeNullCompanySignal = signal<boolean>(true);
  readonly searchQuery = signal<string>('');
  readonly selectedId = signal<number | string | null>(null);
  readonly isOpen = signal<boolean>(false);
  readonly disabledSignal = signal<boolean>(false);
  private readonly rememberedSelection = signal<AsyncSelectOption | null>(null);

  readonly filteredOptions = computed(() =>
    filterAsyncSelectOptions(
      this.optionsSignal(),
      this.searchQuery(),
      this.companyIdSignal(),
      this.includeNullCompanySignal(),
    ),
  );

  readonly selectedOption = computed(
    () => this.optionsSignal().find((opt) => opt.id === this.selectedId()) ??
      this.rememberedSelection(),
  );

  readonly displayInputValue = computed(() => {
    if (this.isOpen()) {
      return this.searchQuery();
    }
    return this.selectedOption()?.text ?? this.searchQuery();
  });

  @Input() label = '';
  @Input() placeholder = 'Select an option...';
  @Input() statusType?: string;
  @Input() allowQuickCreate = true;
  @Input() quickCreateLabel = 'New';

  @Input() set options(value: readonly AsyncSelectOption[]) {
    this.optionsSignal.set(value);
  }

  @Input() set companyId(value: number | null | undefined) {
    this.companyIdSignal.set(value ?? null);
  }

  @Input() set includeNullCompany(value: boolean) {
    this.includeNullCompanySignal.set(value);
  }

  @Output() selectionChanged = new EventEmitter<AsyncSelectOption | null>();
  @Output() quickCreate = new EventEmitter<{ query: string; companyId: number | null }>();
  @Output() searchChanged = new EventEmitter<string>();

  private onChangeCallback: (value: number | string | null) => void = () => undefined;
  private onTouchedCallback: () => void = () => undefined;

  ngOnChanges(): void {
    const selected = this.selectedOption();
    if (!selected) return; // An asynchronous option page may not include the current value.

    if (isVisibleInCompany(selected, this.companyIdSignal(), this.includeNullCompanySignal())) {
      this.rememberedSelection.set(selected);
    } else {
      this.writeValue(null);
      this.onChangeCallback(null);
      this.selectionChanged.emit(null);
    }
  }

  writeValue(value: number | string | null): void {
    if (this.rememberedSelection()?.id !== value) {
      this.rememberedSelection.set(null);
    }
    this.selectedId.set(value ?? null);
    this.rememberedSelection.set(this.selectedOption());
  }

  registerOnChange(fn: (value: number | string | null) => void): void {
    this.onChangeCallback = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouchedCallback = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabledSignal.set(isDisabled);
  }

  openDropdown(): void {
    if (!this.disabledSignal()) {
      this.isOpen.set(true);
    }
  }

  onSearchChange(value: string): void {
    this.searchQuery.set(value);
    this.isOpen.set(true);
    this.searchChanged.emit(value);
  }

  selectOption(option: AsyncSelectOption): void {
    this.selectedId.set(option.id);
    this.rememberedSelection.set(option);
    this.searchQuery.set('');
    this.isOpen.set(false);
    this.onChangeCallback(option.id);
    this.onTouchedCallback();
    this.selectionChanged.emit(option);
  }

  clearSelection(): void {
    this.writeValue(null);
    this.searchQuery.set('');
    this.onChangeCallback(null);
    this.onTouchedCallback();
    this.selectionChanged.emit(null);
  }

  triggerQuickCreate(): void {
    this.quickCreate.emit({
      query: this.searchQuery(),
      companyId: this.companyIdSignal(),
    });
  }
}

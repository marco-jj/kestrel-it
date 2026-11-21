import { A11yModule } from '@angular/cdk/a11y';
import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  HostListener,
  Inject,
  Input,
  Optional,
  Output,
  computed,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import type { PermissionKey } from '@kestrel-it/shared';
import { AuthStore } from '../../core/auth/auth.store.js';
import { ThemeStore } from '../../core/theme/theme.store.js';

export interface CommandItem {
  id: string;
  label: string;
  category: 'navigation' | 'action' | 'theme';
  route?: string;
  shortcut?: string;
  requiredPermission?: PermissionKey;
  keywords?: string[];
}

export const DEFAULT_COMMAND_ITEMS: readonly CommandItem[] = [
  { id: 'nav-dashboard', label: 'Go to Dashboard', category: 'navigation', route: '/dashboard', shortcut: 'G D' },
  {
    id: 'nav-hardware',
    label: 'Hardware Assets',
    category: 'navigation',
    route: '/hardware',
    requiredPermission: 'assets.view',
    keywords: ['assets', 'laptop', 'server', 'inventory'],
  },
  {
    id: 'nav-models',
    label: 'Asset Models',
    category: 'navigation',
    route: '/models',
    requiredPermission: 'models.view',
    keywords: ['hardware', 'specs'],
  },
  {
    id: 'nav-licenses',
    label: 'Software Licenses',
    category: 'navigation',
    route: '/licenses',
    requiredPermission: 'licenses.view',
    keywords: ['seats', 'software', 'keys'],
  },
  {
    id: 'nav-users',
    label: 'People & Users',
    category: 'navigation',
    route: '/users',
    requiredPermission: 'users.view',
    keywords: ['staff', 'employees'],
  },
  {
    id: 'nav-companies',
    label: 'Companies (FMCS)',
    category: 'navigation',
    route: '/companies',
    requiredPermission: 'companies.view',
    keywords: ['tenant', 'org', 'multi-company'],
  },
  {
    id: 'nav-locations',
    label: 'Locations',
    category: 'navigation',
    route: '/locations',
    requiredPermission: 'locations.view',
    keywords: ['sites', 'offices'],
  },
  {
    id: 'nav-settings',
    label: 'Global Settings',
    category: 'navigation',
    route: '/admin/settings',
    requiredPermission: 'superuser',
    keywords: ['admin', 'oidc', 'branding'],
  },
  {
    id: 'act-create-asset',
    label: 'Create Hardware Asset',
    category: 'action',
    route: '/hardware/create',
    shortcut: 'N A',
    requiredPermission: 'assets.create',
    keywords: ['new', 'add', 'hardware'],
  },
  {
    id: 'act-checkout-asset',
    label: 'Bulk Asset Checkout',
    category: 'action',
    route: '/hardware/bulk-checkout',
    requiredPermission: 'assets.checkout',
    keywords: ['assign', 'user', 'location'],
  },
  {
    id: 'theme-toggle',
    label: 'Toggle Light / Dark Theme',
    category: 'theme',
    shortcut: 'T',
    keywords: ['appearance', 'dark mode', 'light mode', 'zinc'],
  },
];

export function filterCommandItems(
  items: readonly CommandItem[],
  query: string,
  authStore: AuthStore,
): CommandItem[] {
  const permitted = items.filter(
    (item) => !item.requiredPermission || authStore.can(item.requiredPermission),
  );
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return permitted;
  }

  return permitted.filter((item) => {
    const haystack = [
      item.label,
      item.category,
      item.route ?? '',
      ...(item.keywords ?? []),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(normalized);
  });
}

@Component({
  selector: 'kestrel-command-palette',
  standalone: true,
  imports: [CommonModule, A11yModule],
  template: `
    @if (isOpen()) {
      <div class="palette-backdrop" (click)="close()">
        <div
          class="palette-surface"
          role="dialog"
          aria-modal="true"
          aria-label="Global Command Palette"
          cdkTrapFocus
          [cdkTrapFocusAutoCapture]="true"
          (click)="$event.stopPropagation()"
        >
          <div class="palette-search-row">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" stroke-linecap="round" />
            </svg>
            <input
              type="text"
              class="palette-input"
              placeholder="Jump to inventory module, action, or theme..."
              [value]="searchQuery()"
              (input)="onQueryInput($any($event.target).value)"
              aria-label="Command search"
            />
            <span class="k-kbd">Esc</span>
          </div>

          <div class="palette-list" role="listbox">
            @for (item of filteredItems(); track item.id; let i = $index) {
              <button
                type="button"
                class="palette-item"
                [class.active]="i === activeIndex()"
                role="option"
                [attr.aria-selected]="i === activeIndex()"
                (click)="executeItem(item)"
                (mouseenter)="activeIndex.set(i)"
              >
                <span class="item-meta">
                  <span class="item-cat k-mono">{{ item.category }}</span>
                  <span class="item-label">{{ item.label }}</span>
                </span>
                @if (item.shortcut || item.route) {
                  <span class="k-kbd">{{ item.shortcut || item.route }}</span>
                }
              </button>
            } @empty {
              <div class="palette-empty">
                No matching modules or commands for <span class="k-mono">"{{ searchQuery() }}"</span>.
              </div>
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .palette-backdrop {
        position: fixed;
        inset: 0;
        z-index: 70;
        background: rgba(9, 9, 11, 0.56);
        backdrop-filter: blur(4px);
        display: flex;
        justify-content: center;
        align-items: flex-start;
        padding: min(14vh, 7rem) 1rem 2rem;
      }
      .palette-surface {
        width: min(600px, 100%);
        background: var(--kestrel-surface);
        border: 1px solid var(--kestrel-border-strong);
        border-radius: var(--kestrel-radius-lg);
        box-shadow: var(--kestrel-shadow-lg);
        overflow: hidden;
        animation: kestrel-palette-in 150ms var(--kestrel-ease-spring);
      }
      .palette-search-row {
        display: flex;
        align-items: center;
        gap: 0.65rem;
        padding: 0.75rem 1rem;
        border-bottom: 1px solid var(--kestrel-border);
        color: var(--kestrel-muted);
      }
      .palette-input {
        flex: 1;
        border: 0;
        background: transparent;
        color: var(--kestrel-ink);
        font-family: inherit;
        font-size: 0.92rem;
        outline: none;
      }
      .palette-list {
        max-height: 360px;
        overflow-y: auto;
        padding: 0.45rem;
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
      }
      .palette-item {
        width: 100%;
        border: 0;
        background: transparent;
        color: var(--kestrel-ink);
        padding: 0.55rem 0.75rem;
        border-radius: var(--kestrel-radius-md);
        display: flex;
        align-items: center;
        justify-content: space-between;
        text-align: left;
        cursor: pointer;
        font-family: inherit;
      }
      .palette-item.active,
      .palette-item:hover {
        background: var(--kestrel-surface-subtle);
      }
      .item-meta {
        display: flex;
        align-items: center;
        gap: 0.65rem;
      }
      .item-cat {
        font-size: 0.68rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--kestrel-accent);
        min-width: 72px;
      }
      .item-label {
        font-size: 0.875rem;
        font-weight: 500;
      }
      .palette-empty {
        padding: 1.5rem 1rem;
        text-align: center;
        color: var(--kestrel-muted);
        font-size: 0.84rem;
      }
      @keyframes kestrel-palette-in {
        from {
          transform: translateY(-8px) scale(0.985);
          opacity: 0;
        }
        to {
          transform: translateY(0) scale(1);
          opacity: 1;
        }
      }
    `,
  ],
})
export class KestrelCommandPaletteComponent {
  readonly isOpen = signal<boolean>(false);
  readonly searchQuery = signal<string>('');
  readonly activeIndex = signal<number>(0);
  readonly itemsSignal = signal<readonly CommandItem[]>(DEFAULT_COMMAND_ITEMS);

  readonly filteredItems = computed(() =>
    filterCommandItems(this.itemsSignal(), this.searchQuery(), this.authStore),
  );

  @Input() set open(val: boolean) {
    this.isOpen.set(val);
    if (val) {
      this.activeIndex.set(0);
    }
  }

  @Input() set items(value: readonly CommandItem[]) {
    this.itemsSignal.set(value);
  }

  @Output() openChange = new EventEmitter<boolean>();
  @Output() actionTriggered = new EventEmitter<CommandItem>();

  constructor(
    @Inject(AuthStore) private readonly authStore: AuthStore,
    @Inject(ThemeStore) private readonly themeStore: ThemeStore,
    @Optional() @Inject(Router) private readonly router?: Router,
  ) {}

  openPalette(): void {
    this.isOpen.set(true);
    this.searchQuery.set('');
    this.activeIndex.set(0);
    this.openChange.emit(true);
  }

  close(): void {
    this.isOpen.set(false);
    this.searchQuery.set('');
    this.openChange.emit(false);
  }

  onQueryInput(value: string): void {
    this.searchQuery.set(value);
    this.activeIndex.set(0);
  }

  executeItem(item: CommandItem): void {
    if (item.category === 'theme') {
      this.themeStore.toggleTheme();
    } else if (item.route) {
      void this.router?.navigateByUrl(item.route);
    }
    this.actionTriggered.emit(item);
    this.close();
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (this.isOpen()) {
        this.close();
      } else {
        this.openPalette();
      }
      return;
    }

    if (!this.isOpen()) {
      return;
    }

    const list = this.filteredItems();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    } else if (event.key === 'ArrowDown' && list.length > 0) {
      event.preventDefault();
      this.activeIndex.set((this.activeIndex() + 1) % list.length);
    } else if (event.key === 'ArrowUp' && list.length > 0) {
      event.preventDefault();
      this.activeIndex.set((this.activeIndex() - 1 + list.length) % list.length);
    } else if (event.key === 'Enter' && list.length > 0) {
      event.preventDefault();
      const selected = list[this.activeIndex()];
      if (selected) {
        this.executeItem(selected);
      }
    }
  }
}

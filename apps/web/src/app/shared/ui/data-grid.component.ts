import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, computed, signal } from '@angular/core';
import { KestrelStatusBadgeComponent } from './status-badge.component.js';

export interface DataGridColumn<T = Record<string, unknown>> {
  key: string;
  label: string;
  sortable?: boolean;
  mono?: boolean;
  align?: 'left' | 'right' | 'center';
  type?: 'text' | 'mono' | 'status' | 'currency' | 'date';
  width?: string;
}

export interface DataGridRowActions {
  view?: boolean;
  files?: boolean;
  request?: boolean;
  cancel?: boolean;
  checkout?: boolean;
  audit?: boolean;
  checkin?: boolean;
  update?: boolean;
  delete?: boolean;
  clone?: boolean;
  restore?: boolean;
}

export type DataGridActionType = keyof DataGridRowActions;

export type DataGridRow = Record<string, unknown> & {
  id?: number | string;
  available_actions?: DataGridRowActions | null;
};

const ORDERED_ROW_ACTIONS: readonly DataGridActionType[] = [
  'view',
  'files',
  'request',
  'cancel',
  'checkout',
  'checkin',
  'audit',
  'update',
  'clone',
  'delete',
  'restore',
];

export function resolveAvailableRowActions(
  actions?: DataGridRowActions | null,
): DataGridActionType[] {
  if (!actions) {
    return [];
  }
  return ORDERED_ROW_ACTIONS.filter((action) => actions[action] === true);
}

function cellText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return value instanceof Date ? value.toString() : null;
}

export function sortDataGridRows<T extends Record<string, unknown>>(
  rows: readonly T[],
  sortKey: string | null,
  sortDir: 'asc' | 'desc',
): T[] {
  if (!sortKey) {
    return [...rows];
  }
  const factor = sortDir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const aVal = a[sortKey];
    const bVal = b[sortKey];

    if (aVal === bVal) return 0;
    if (typeof aVal === 'number' && typeof bVal === 'number') {
      return (aVal - bVal) * factor;
    }

    const aText = cellText(aVal);
    const bText = cellText(bVal);
    if (aText === bText) return 0;
    if (aText === null) return 1;
    if (bText === null) return -1;

    return aText.localeCompare(bText, undefined, { numeric: true }) * factor;
  });
}

export function toggleRowSelectionSet(
  selected: ReadonlySet<number | string>,
  id: number | string,
): Set<number | string> {
  const next = new Set(selected);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

@Component({
  selector: 'kestrel-data-grid',
  standalone: true,
  imports: [CommonModule, KestrelStatusBadgeComponent],
  template: `
    <div class="grid-shell">
      <div class="grid-toolbar">
        @if (searchable) {
        <div class="search-box">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" stroke-linecap="round" />
          </svg>
          <input
            type="text"
            class="search-input"
            placeholder="Filter records by tag, serial, name..."
            [value]="searchQuery()"
            (input)="onSearchInput($any($event.target).value)"
            aria-label="Search table records"
          />
        </div>
        }

        <div class="toolbar-right">
          @if (selectedIds().size > 0) {
            <div class="bulk-bar">
              <span class="k-mono bulk-count">{{ selectedIds().size }} selected</span>
              @if (bulkRestore) {
                <button type="button" class="k-btn k-btn-secondary bulk-btn" (click)="emitBulkAction('bulk_restore')">Restore</button>
              }
              @if (bulkAudit) {
                <button type="button" class="k-btn k-btn-secondary bulk-btn" (click)="emitBulkAction('bulk_audit')">Audit</button>
              }
              @if (bulkEdit) {
              <button
                type="button"
                class="k-btn k-btn-secondary bulk-btn"
                (click)="emitBulkAction('bulk_edit')"
              >
                Bulk Edit
              </button>
              }
              @if (bulkDelete) {
              <button
                type="button"
                class="k-btn k-btn-danger bulk-btn"
                (click)="emitBulkAction('bulk_delete')"
              >
                Delete
              </button>
              }
              <button type="button" class="k-btn k-btn-ghost bulk-btn" (click)="clearSelection()">
                Clear
              </button>
            </div>
          } @else if (creatable) {
            <button
              type="button"
              class="k-btn k-btn-primary"
              (click)="createClicked.emit()"
            >
              + {{ createLabel }}
            </button>
          }
        </div>
      </div>

      <div class="table-wrap">
        <table class="k-table">
          <thead>
            <tr>
              @if (selectable) {
                <th class="col-check">
                  <input
                    type="checkbox"
                    [checked]="allVisibleSelected()"
                    (change)="toggleSelectAll()"
                    aria-label="Select all visible rows"
                  />
                </th>
              }
              @for (col of columnsSignal(); track col.key) {
                <th
                  [style.width]="col.width ?? null"
                  [style.text-align]="col.align ?? 'left'"
                >
                  @if (col.sortable !== false) {
                    <button
                      type="button"
                      class="sort-btn"
                      (click)="toggleSort(col)"
                    >
                      <span>{{ col.label }}</span>
                      @if (sortKey() === col.key) {
                        <span class="k-mono sort-indicator">{{ sortDir() === 'asc' ? 'ASC' : 'DESC' }}</span>
                      }
                    </button>
                  } @else {
                    <span>{{ col.label }}</span>
                  }
                </th>
              }
              <th class="col-actions">Actions</th>
            </tr>
          </thead>

          <tbody>
            @if (loadingSignal()) {
              @for (skeletonRow of skeletonRows; track skeletonRow) {
                <tr>
                  @if (selectable) {
                    <td><div class="k-skeleton" style="width: 16px; height: 16px;"></div></td>
                  }
                  @for (col of columnsSignal(); track col.key) {
                    <td><div class="k-skeleton" style="width: 78%; height: 14px;"></div></td>
                  }
                  <td><div class="k-skeleton" style="width: 64px; height: 18px; margin-left: auto;"></div></td>
                </tr>
              }
            } @else {
              @for (row of displayedRows(); track getRowId(row, $index)) {
                <tr [class.selected]="selectedIds().has(getRowId(row, $index))">
                  @if (selectable) {
                    <td class="col-check">
                      <input
                        type="checkbox"
                        [checked]="selectedIds().has(getRowId(row, $index))"
                        (change)="toggleRowSelection(getRowId(row, $index))"
                        [attr.aria-label]="'Select row ' + getRowId(row, $index)"
                      />
                    </td>
                  }
                  @for (col of columnsSignal(); track col.key) {
                    <td
                      [class.k-mono]="isMonoColumn(col)"
                      [style.text-align]="col.align ?? 'left'"
                    >
                      @if (col.type === 'status') {
                        <kestrel-status-badge
                          [statusMeta]="asStringOrNull(row[col.key])"
                          [label]="asStringOrNull(row[col.key + '_label']) ?? undefined"
                        />
                      } @else {
                        {{ formatCell(row, col) }}
                      }
                    </td>
                  }
                  <td class="col-actions">
                    <div class="action-group">
                      @for (action of getRowActions(row); track action) {
                        <button
                          type="button"
                          class="k-btn action-pill"
                          [class.k-btn-primary]="action === 'checkout'"
                          [class.k-btn-secondary]="action !== 'checkout' && action !== 'delete'"
                          [class.k-btn-danger]="action === 'delete'"
                          (click)="rowAction.emit({ action, row })"
                        >
                          {{ action }}
                        </button>
                      }
                    </div>
                  </td>
                </tr>
              } @empty {
                <tr>
                  <td [attr.colspan]="columnsSignal().length + (selectable ? 2 : 1)">
                    <div class="empty-state">
                      <p class="empty-title">{{ emptyTitle }}</p>
                      <p class="empty-desc">{{ emptyDescription }}</p>
                    </div>
                  </td>
                </tr>
              }
            }
          </tbody>
        </table>
      </div>

      <div class="grid-footer">
        <span class="k-mono footer-meta">
          Showing {{ displayedRows().length }} of {{ effectiveTotal() }} records — Page {{ pageSignal() }} / {{ totalPages() }}
        </span>
        <div class="pager-controls">
          <button
            type="button"
            class="k-btn k-btn-secondary pager-btn"
            [disabled]="pageSignal() <= 1"
            (click)="goToPage(pageSignal() - 1)"
          >
            Previous
          </button>
          <button
            type="button"
            class="k-btn k-btn-secondary pager-btn"
            [disabled]="pageSignal() >= totalPages()"
            (click)="goToPage(pageSignal() + 1)"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      .grid-shell {
        background: var(--kestrel-surface);
        border: 1px solid var(--kestrel-border);
        border-radius: var(--kestrel-radius-lg);
        box-shadow: var(--kestrel-shadow-sm);
        overflow: hidden;
      }
      .grid-toolbar {
        padding: 0.75rem 1rem;
        border-bottom: 1px solid var(--kestrel-border);
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
      }
      .search-box {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        min-width: min(300px, 100%);
        flex: 1;
        max-width: 420px;
        padding: 0.35rem 0.65rem;
        border: 1px solid var(--kestrel-border-strong);
        border-radius: var(--kestrel-radius-md);
        background: var(--kestrel-canvas);
        color: var(--kestrel-muted);
      }
      .search-input {
        width: 100%;
        border: 0;
        background: transparent;
        color: var(--kestrel-ink);
        font-family: inherit;
        font-size: 0.84rem;
        outline: none;
      }
      .bulk-bar {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .bulk-count {
        font-size: 0.78rem;
        color: var(--kestrel-accent);
        font-weight: 600;
      }
      .bulk-btn,
      .pager-btn {
        min-height: 30px;
        padding: 0.25rem 0.6rem;
        font-size: 0.78rem;
      }
      .table-wrap {
        width: 100%;
        overflow-x: auto;
      }
      .k-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.84rem;
      }
      .k-table th {
        background: var(--kestrel-surface-subtle);
        color: var(--kestrel-muted);
        font-size: 0.72rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 0.55rem 0.75rem;
        border-bottom: 1px solid var(--kestrel-border);
        white-space: nowrap;
      }
      .k-table td {
        padding: 0.58rem 0.75rem;
        border-bottom: 1px solid var(--kestrel-border);
        color: var(--kestrel-ink);
        vertical-align: middle;
      }
      .k-table tbody tr:hover {
        background: var(--kestrel-surface-subtle);
      }
      .k-table tbody tr.selected {
        background: var(--kestrel-accent-subtle);
      }
      .col-check {
        width: 38px;
        text-align: center;
      }
      .col-actions {
        text-align: right;
        white-space: nowrap;
      }
      .sort-btn {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        text-transform: inherit;
        letter-spacing: inherit;
        cursor: pointer;
        padding: 0;
      }
      .sort-indicator {
        font-size: 0.65rem;
        color: var(--kestrel-accent);
      }
      .action-group {
        display: inline-flex;
        gap: 0.35rem;
        justify-content: flex-end;
      }
      .action-pill {
        min-height: 26px;
        padding: 0.15rem 0.5rem;
        font-size: 0.74rem;
        text-transform: capitalize;
      }
      .empty-state {
        padding: 2.25rem 1rem;
        text-align: center;
      }
      .empty-title {
        margin: 0;
        font-weight: 600;
        font-size: 0.92rem;
      }
      .empty-desc {
        margin: 0.35rem 0 0;
        color: var(--kestrel-muted);
        font-size: 0.82rem;
      }
      .grid-footer {
        padding: 0.65rem 1rem;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        background: var(--kestrel-surface);
      }
      .footer-meta {
        font-size: 0.76rem;
        color: var(--kestrel-muted);
      }
      .pager-controls {
        display: flex;
        gap: 0.45rem;
      }
    `,
  ],
})
export class KestrelDataGridComponent {
  readonly skeletonRows = [1, 2, 3, 4];

  readonly columnsSignal = signal<readonly DataGridColumn[]>([]);
  readonly rowsSignal = signal<readonly DataGridRow[]>([]);
  readonly totalSignal = signal<number>(0);
  readonly pageSignal = signal<number>(1);
  readonly pageSizeSignal = signal<number>(20);
  readonly loadingSignal = signal<boolean>(false);
  private readonly serverSideSignal = signal(true);

  readonly sortKey = signal<string | null>(null);
  readonly sortDir = signal<'asc' | 'desc'>('asc');
  readonly searchQuery = signal<string>('');
  readonly selectedIds = signal<ReadonlySet<number | string>>(new Set());

  readonly displayedRows = computed(() => {
    const base = this.rowsSignal();
    if (this.serverSideSignal()) return base;

    const query = this.searchQuery().trim().toLowerCase();
    const filtered = query
      ? base.filter((row) =>
          this.columnsSignal().some((col) =>
            cellText(row[col.key])?.toLowerCase().includes(query),
          ),
        )
      : base;
    return sortDataGridRows(filtered, this.sortKey(), this.sortDir());
  });

  readonly effectiveTotal = computed(() => {
    const explicit = this.totalSignal();
    return explicit > 0 ? explicit : this.rowsSignal().length;
  });

  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.effectiveTotal() / Math.max(1, this.pageSizeSignal()))),
  );

  readonly allVisibleSelected = computed(() => {
    const rows = this.displayedRows();
    if (rows.length === 0) {
      return false;
    }
    const selected = this.selectedIds();
    return rows.every((row, index) => selected.has(this.getRowId(row, index)));
  });

  @Input() set columns(value: readonly DataGridColumn[]) {
    this.columnsSignal.set(value);
  }

  @Input() set rows(value: readonly DataGridRow[]) {
    this.rowsSignal.set(value);
  }

  @Input() set total(value: number) {
    this.totalSignal.set(value);
  }

  @Input() set page(value: number) {
    this.pageSignal.set(value);
  }

  @Input() set pageSize(value: number) {
    this.pageSizeSignal.set(value);
  }

  @Input() set loading(value: boolean) {
    this.loadingSignal.set(value);
  }

  @Input() set serverSide(value: boolean) {
    this.serverSideSignal.set(value);
  }

  @Input() emptyTitle = 'No matching records';
  @Input() emptyDescription = 'Adjust your filters or create a new record to populate this table.';
  @Input() selectable = true;
  @Input() searchable = true;
  @Input() creatable = true;
  @Input() bulkEdit = true;
  @Input() bulkAudit = false;
  @Input() bulkDelete = true;
  @Input() bulkRestore = false;
  @Input() idKey = 'id';
  @Input() createLabel = 'New Record';

  @Output() sortChanged = new EventEmitter<{ sort: string; order: 'asc' | 'desc' }>();
  @Output() pageChanged = new EventEmitter<number>();
  @Output() searchChanged = new EventEmitter<string>();
  @Output() rowAction = new EventEmitter<{ action: DataGridActionType; row: DataGridRow }>();
  @Output() bulkAction = new EventEmitter<{
    action: string;
    selectedIds: Array<number | string>;
  }>();
  @Output() createClicked = new EventEmitter<void>();

  getRowId(row: DataGridRow, fallbackIndex: number): number | string {
    const val = row[this.idKey];
    return typeof val === 'number' || typeof val === 'string' ? val : fallbackIndex;
  }

  toggleSort(col: DataGridColumn): void {
    if (col.sortable === false) {
      return;
    }
    const nextDir: 'asc' | 'desc' =
      this.sortKey() === col.key && this.sortDir() === 'asc' ? 'desc' : 'asc';
    this.sortKey.set(col.key);
    this.sortDir.set(nextDir);
    this.sortChanged.emit({ sort: col.key, order: nextDir });
  }

  onSearchInput(value: string): void {
    this.searchQuery.set(value);
    this.searchChanged.emit(value);
  }

  toggleRowSelection(id: number | string): void {
    this.selectedIds.set(toggleRowSelectionSet(this.selectedIds(), id));
  }

  toggleSelectAll(): void {
    const rows = this.displayedRows();
    if (this.allVisibleSelected()) {
      this.selectedIds.set(new Set());
      return;
    }
    const next = new Set<number | string>(this.selectedIds());
    rows.forEach((row, index) => next.add(this.getRowId(row, index)));
    this.selectedIds.set(next);
  }

  clearSelection(): void {
    this.selectedIds.set(new Set());
  }

  emitBulkAction(action: string): void {
    this.bulkAction.emit({
      action,
      selectedIds: [...this.selectedIds()],
    });
  }

  goToPage(nextPage: number): void {
    const bounded = Math.max(1, Math.min(this.totalPages(), nextPage));
    if (bounded === this.pageSignal()) {
      return;
    }
    this.pageSignal.set(bounded);
    this.pageChanged.emit(bounded);
  }

  getRowActions(row: DataGridRow): DataGridActionType[] {
    return resolveAvailableRowActions(row.available_actions);
  }

  isMonoColumn(col: DataGridColumn): boolean {
    return Boolean(col.mono || col.type === 'mono' || col.type === 'currency' || col.type === 'date');
  }

  asStringOrNull(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  formatCell(row: DataGridRow, col: DataGridColumn): string {
    return cellText(row[col.key]) || '—';
  }
}

import { InventoryFilesComponent, saveDownload } from './inventory-files.component.js';
import { Component, OnInit, inject, signal, viewChild } from '@angular/core';
import {
  FormControl,
  FormGroup,
  FormRecord,
  FormsModule,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { InventoryCustomField } from '@kestrel-it/shared';
import { AuthStore } from '../../core/auth/auth.store.js';
import {
  KestrelDataGridComponent,
  type DataGridActionType,
  type DataGridColumn,
  type DataGridRow,
} from '../../shared/ui/data-grid.component.js';
import { KestrelSlideDrawerComponent } from '../../shared/ui/slide-drawer.component.js';
import {
  CustomFieldFormSectionComponent,
  customFieldChanges,
} from './custom-field-form-section.component.js';
import { field, permissionFor, reference, type InventoryField } from './directory-ui.js';
import { InventoryApi, inventoryError } from './inventory-api.js';
import { InventoryFormFieldsComponent } from './inventory-form-fields.component.js';

import { AssetAuditFormComponent } from './asset-audit-form.component.js';
import { OrderItemsComponent } from './order-items.component.js';
import { AssetLifecycleComponent } from './asset-lifecycle.component.js';

const modelFields: InventoryField[] = [
  { key: 'name', label: 'Model name', required: true },
  field('model_number', 'Model number'),
  reference('manufacturer_id', 'Manufacturer', 'manufacturers'),
  { ...reference('category_id', 'Category', 'categories'), required: true },
  reference('fieldset_id', 'Custom fieldset', 'fieldsets'),
  reference('depreciation_id', 'Depreciation schedule', 'depreciations'),
  field('eol', 'End of life (months)', 'number'),
  field('min_amt', 'Minimum quantity', 'number'),
  field('require_serial', 'Require a serial number', 'boolean'),
  field('requestable', 'Available to request', 'boolean'),
  field('notes', 'Notes', 'textarea'),
];
const assetFields: InventoryField[] = [
  field('asset_tag', 'Asset tag'),
  field('name', 'Name'),
  field('serial', 'Serial number'),
  { ...reference('model_id', 'Model', 'models'), required: true },
  { ...reference('status_id', 'Status', 'statuslabels'), required: true },
  reference('company_id', 'Company', 'companies'),
  reference('supplier_id', 'Supplier', 'suppliers'),
  reference('rtd_location_id', 'Home location', 'locations'),
  reference('location_id', 'Current location', 'locations'),
  field('purchase_date', 'Purchase date', 'date'),
  field('purchase_cost', 'Purchase cost'),
  field('order_number', 'Order number'),
  field('warranty_months', 'Warranty (months)', 'number'),
  field('asset_eol_date', 'End of life date', 'date'),
  field('byod', 'Personally owned', 'boolean'),
  field('requestable', 'Available to request', 'boolean'),
  field('notes', 'Notes', 'textarea'),
];
const statuses = ['deployable', 'deployed', 'pending', 'archived', 'undeployable'];
const filterFields: InventoryField[] = [
  reference('model_id', 'Model', 'models'),
  reference('company_id', 'Company', 'companies'),
  reference('category_id', 'Category', 'categories'),
  reference('location_id', 'Current location', 'locations'),
  reference('supplier_id', 'Supplier', 'suppliers'),
  reference('manufacturer_id', 'Manufacturer', 'manufacturers'),
  { key: 'status', label: 'Status', type: 'enum', options: statuses },
  field('tag', 'Exact asset tag'),
  field('serial', 'Exact serial number'),
  field('custom_value', 'Custom field value'),
];
type SavedSearch = { id: number; name: string; query: Record<string, string | number | boolean> };
type DrawerMode = 'view' | 'edit' | 'clone' | 'delete' | 'restore' | 'bulk_edit';
type AssetFormRecord = DataGridRow & {
  model_id: number | null;
  custom_field_schema: InventoryCustomField[];
  custom_fields: Record<string, { field: string; value: unknown }>;
};

@Component({
  selector: 'kestrel-hardware-page',
  standalone: true,
  imports: [
    FormsModule,
    ReactiveFormsModule,
    KestrelDataGridComponent,
    KestrelSlideDrawerComponent,
    InventoryFormFieldsComponent,
    CustomFieldFormSectionComponent,
    AssetLifecycleComponent,
    AssetAuditFormComponent,
    OrderItemsComponent,
    InventoryFilesComponent,
    RouterLink,
  ],
  template: `
    <header class="inventory-header">
      <h1>{{ isHardware ? 'Hardware' : 'Asset Models' }}</h1>
      @if (isHardware && canCheckin()) {
        <form class="toolbar" (ngSubmit)="scan()">
          <input
            aria-label="Asset tag for Quickscan"
            name="scanTag"
            placeholder="Asset tag"
            [(ngModel)]="scanTag"
          />
          <button type="submit" class="k-btn k-btn-secondary" [disabled]="!scanTag.trim()">
            Quickscan check-in
          </button>
        </form>
      }
      @if (can('delete')) {
        <button type="button" class="k-btn k-btn-secondary" (click)="toggleDeleted()">
          {{ deleted() ? 'Show active records' : 'Show deleted records' }}
        </button>
      }
    </header>
    @if (isHardware && !deleted()) {
      <details class="filters">
        <summary>Filters and saved searches</summary>
        <form [formGroup]="filterForm" (ngSubmit)="applyFilters()">
          <kestrel-inventory-form-fields [form]="filterForm" [fields]="filters" />
          <label
            >Custom field
            <select formControlName="custom_field">
              <option [ngValue]="null">No field</option>
              @for (item of filterable(); track item.db_column) {
                <option [value]="item.db_column">{{ item.name }}</option>
              }
            </select>
          </label>
          <div class="toolbar">
            <button class="k-btn k-btn-primary" type="submit">Apply filters</button>
            <button class="k-btn k-btn-secondary" type="button" (click)="clearFilters()">
              Clear filters
            </button>
          </div>
        </form>
        <div class="toolbar">
          <input
            aria-label="Saved search name"
            placeholder="Saved search name"
            [(ngModel)]="searchName"
          />
          <button
            class="k-btn k-btn-secondary"
            type="button"
            [disabled]="!searchName.trim()"
            (click)="saveSearch()"
          >
            Save search
          </button>
          <select aria-label="Saved searches" [(ngModel)]="selectedSearch">
            <option [ngValue]="null">Saved searches</option>
            @for (item of savedSearches(); track item.id) {
              <option [ngValue]="item.id">{{ item.name }}</option>
            }
          </select>
          <button
            class="k-btn k-btn-secondary"
            type="button"
            [disabled]="!selectedSearch"
            (click)="useSearch()"
          >
            Load
          </button>
          <button
            class="k-btn k-btn-secondary"
            type="button"
            [disabled]="!selectedSearch"
            (click)="deleteSearch()"
          >
            Delete
          </button>
        </div>
      </details>
    }
    @if (error() && !drawer()) {
      <p role="alert">{{ error() }}</p>
    }
    @if (message()) {
      <p role="status">{{ message() }}</p>
    }
    @if (isHardware && canAudit() && !deleted()) {
      <div class="toolbar">
        <a class="k-btn k-btn-secondary" routerLink="/hardware/audit/due">Audits due</a>
        <a class="k-btn k-btn-secondary" routerLink="/hardware/audit/overdue">Overdue audits</a>
      </div>
    }
    @if (isHardware && !deleted()) {
      <button class="k-btn k-btn-secondary" [disabled]="!grid()?.selectedIds()?.size" (click)="printSelected()">Print selected labels</button>
    }
    <kestrel-data-grid
      [columns]="columns"
      [rows]="rows()"
      [total]="total()"
      [page]="page()"
      [loading]="loading()"
      [creatable]="can('create') && !deleted()"
      [selectable]="isHardware && (!deleted() || can('delete'))"
      [bulkAudit]="isHardware && !deleted() && canAudit()"
      [bulkEdit]="!deleted() && can('edit')"
      [bulkDelete]="!deleted() && can('delete')"
      [bulkRestore]="deleted() && can('delete')"
      (createClicked)="open('edit')"
      (rowAction)="act($event)"
      (bulkAction)="bulk($event)"
      (searchChanged)="searchChanged($event)"
      (sortChanged)="sort = $event.sort; order = $event.order; load()"
      (pageChanged)="page.set($event); load()"
    />
    <kestrel-slide-drawer [open]="audit() !== null" title="Audit assets" (closed)="auditClosed()">
      @if (audit(); as job) {
        <kestrel-asset-audit-form [asset]="job.asset" [ids]="job.ids" (saved)="auditSaved($event)" (closed)="auditClosed()" />
      }
    </kestrel-slide-drawer>
    <kestrel-slide-drawer
      [open]="drawer()"
      [title]="drawerTitle()"
      size="xl"
      (closed)="drawer.set(false)"
    >
      @if (drawer()) {
        @switch (mode()) {
          @case ('view') {
            <div class="toolbar">
              <button type="button" class="k-btn k-btn-secondary" (click)="selectDetailTab('overview')">Overview</button>
              <button type="button" class="k-btn k-btn-secondary" (click)="selectDetailTab('orders')">Orders</button>
              @if (isHardware) {
                <button type="button" class="k-btn k-btn-secondary" (click)="selectDetailTab('licenses')">Licenses</button>
                <button type="button" class="k-btn k-btn-secondary" (click)="selectDetailTab('components')">Components</button>
                <button type="button" class="k-btn k-btn-secondary" (click)="selectDetailTab('accessories')">Accessories</button>
                <button type="button" class="k-btn k-btn-secondary" (click)="selectDetailTab('maintenances')">Maintenances</button>
              }
              @if (canReadFiles()) {
                <button type="button" class="k-btn k-btn-secondary" (click)="selectDetailTab('files')">Files</button>
              }
              @if (isHardware && detailTag()) {
                <button type="button" class="k-btn k-btn-secondary" (click)="printTags([detailTag()])">Print label</button>
              }
            </div>
            @if (detailTab() === 'files' && recordId()) {
              <kestrel-inventory-files [resource]="isHardware ? 'hardware' : 'models'" [itemId]="recordId()!" [canWrite]="canWriteFiles()" />
            } @else if (detailTab() === 'orders' && recordId()) {
              <kestrel-order-items [itemId]="recordId()!" [itemType]="isHardware ? 'asset' : 'model'" />
            } @else if (detailTab() === 'licenses' || detailTab() === 'components' || detailTab() === 'accessories' || detailTab() === 'maintenances') {
              @if (detailSubLoading()) {
                <p role="status">Loading {{ detailTab() }}…</p>
              } @else if (detailSubRows().length) {
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Name / Title</th>
                        <th>Key / Type / Qty</th>
                        <th>Date / Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (sub of detailSubRows(); track $index) {
                        <tr>
                          <td>{{ subCell(sub, ['name', 'title']) }}</td>
                          <td class="k-mono">{{ subCell(sub, ['serial', 'model_number', 'maintenance_type', 'assigned_qty', 'seat_id']) }}</td>
                          <td>{{ subCell(sub, ['start_date', 'assigned_at', 'note', 'notes']) }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              } @else {
                <p>No {{ detailTab() }} linked to this asset.</p>
              }
            } @else {
            <dl>
              @for (item of details(); track item.label) {
                <dt>{{ item.label }}</dt>
                <dd>{{ item.value }}</dd>
              }
            </dl>
            <h2>History</h2>
            <ul>
              @for (item of history(); track item.id) {
                <li>{{ item['action_type'] }} · {{ display(item['action_date']) }}
                  @if (item['has_photo']) {
                    <button type="button" class="k-btn k-btn-secondary" (click)="downloadAudit(item)">Download photo</button>
                  }
                </li>
              } @empty {
                <li>No activity recorded.</li>
              }
            </ul>
            }
          }
          @case ('delete') {
            <p>Delete {{ ids().length }} {{ ids().length === 1 ? 'record' : 'records' }}?</p>
          }
          @case ('restore') {
            <p>Restore {{ ids().length }} {{ ids().length === 1 ? 'record' : 'records' }}?</p>
          }
          @default {
            <form [formGroup]="form()" (ngSubmit)="save()">
              <kestrel-inventory-form-fields [form]="form()" [fields]="fields()" />
              @if (loadingFields()) {
                <p role="status">Loading custom fields…</p>
              }
              @if (mode() === 'bulk_edit' && customFields().length) {
                <p>Only custom fields you change will be applied to the selected assets.</p>
              }
              @if (customFields().length && (isHardware || recordId())) {
                <kestrel-custom-field-form-section
                  [form]="customForm()"
                  [fields]="customFields()"
                  [values]="customValues()"
                  [defaultsOnly]="!isHardware"
                />
              }
              @if (retiredFields().length) {
                <label>
                  <input
                    type="checkbox"
                    [checked]="confirmFieldRemoval()"
                    (change)="confirmFieldRemoval.set($any($event.target).checked)"
                  />
                  Remove saved values for fields unavailable on the new model:
                  {{ retiredFields().join(', ') }}.
                </label>
              }
            </form>
          }
        }
        @if (error()) {
          <p role="alert">{{ error() }}</p>
        }
        <div class="toolbar footer">
          <button class="k-btn k-btn-secondary" type="button" (click)="drawer.set(false)">
            {{ mode() === 'view' ? 'Close' : 'Cancel' }}
          </button>
          @if (mode() !== 'view') {
            <button
              class="k-btn k-btn-primary"
              type="button"
              [disabled]="saving() || loadingFields() || fieldLoadFailed()"
              (click)="save()"
            >
              {{ mode() === 'delete' ? 'Delete' : mode() === 'restore' ? 'Restore' : 'Save' }}
            </button>
          }
        </div>
      }
    </kestrel-slide-drawer>
    <kestrel-slide-drawer
      [open]="lifecycle() !== null"
      [title]="lifecycle()?.action === 'checkout' ? 'Check out asset' : 'Check in asset'"
      (closed)="lifecycle.set(null)"
    >
      @if (lifecycle(); as work) {
        <kestrel-asset-lifecycle
          [asset]="work.row"
          [action]="work.action"
          (closed)="lifecycle.set(null)"
          (saved)="lifecycleSaved($event)"
        />
      }
    </kestrel-slide-drawer>
  `,
  styles: [
    `
      .inventory-header {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 0.75rem;
        margin-bottom: 1rem;
      }
      h1 {
        font-size: 1.6rem;
        font-weight: 640;
      }
      h2 {
        margin-top: 1rem;
        font-weight: 600;
      }
      .filters {
        padding: 0.85rem;
        border: 1px solid var(--kestrel-border);
        border-radius: 0.55rem;
        margin-bottom: 1rem;
      }
      summary {
        cursor: pointer;
      }
      details form {
        margin-top: 0.75rem;
      }
      .toolbar {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
        margin-top: 0.75rem;
      }
      .footer {
        justify-content: flex-end;
      }
      input,
      select {
        padding: 0.4rem;
        border: 1px solid var(--kestrel-border);
        border-radius: 0.4rem;
      }
      dl {
        display: grid;
        grid-template-columns: minmax(6rem, 1fr) 2fr;
        gap: 0.4rem 1rem;
      }
      dt {
        font-weight: 600;
      }
      dd {
        overflow-wrap: anywhere;
      }
      [role='alert'] {
        color: var(--kestrel-danger);
        margin-block: 0.6rem;
      }
    `,
  ],
})
export class HardwarePageComponent implements OnInit {
  private readonly api = inject(InventoryApi);
  private readonly auth = inject(AuthStore);
  readonly grid = viewChild(KestrelDataGridComponent);
  private readonly route = inject(ActivatedRoute);
  readonly isHardware = this.route.snapshot.routeConfig?.path?.startsWith('hardware') === true;
  readonly path = this.isHardware ? '/hardware' : '/models';
  readonly permission = this.isHardware ? 'assets' : 'models';
  readonly columns: DataGridColumn[] = this.isHardware
    ? [
        { key: 'asset_tag', label: 'Asset tag', mono: true },
        { key: 'name', label: 'Name' },
        { key: 'serial', label: 'Serial number' },
        { key: 'status_meta', label: 'Status', type: 'status', sortable: false },
      ]
    : [
        { key: 'name', label: 'Name' },
        { key: 'model_number', label: 'Model number', mono: true },
      ];
  readonly filters = filterFields;
  readonly filterForm = new FormGroup<Record<string, FormControl>>(
    Object.fromEntries(
      [...filterFields.map((item) => item.key), 'custom_field'].map((key) => [
        key,
        new FormControl(null),
      ]),
    ),
  );
  readonly filterable = signal<Array<{ db_column: string; name: string }>>([]);
  readonly savedSearches = signal<SavedSearch[]>([]);
  readonly rows = signal<DataGridRow[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly deleted = signal(false);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly drawer = signal(false);
  readonly detailTab = signal<'overview'|'orders'|'files'|'licenses'|'components'|'accessories'|'maintenances'>('overview');
  readonly detailSubRows = signal<DataGridRow[]>([]);
  readonly detailSubLoading = signal(false);
  readonly detailTag = signal('');
  readonly audit = signal<{ asset?: DataGridRow; ids: number[] } | null>(null);
  readonly mode = signal<DrawerMode>('view');
  readonly drawerTitle = signal('');
  readonly error = signal('');
  readonly message = signal('');
  readonly recordId = signal<number | null>(null);
  readonly ids = signal<number[]>([]);
  readonly form = signal(new FormGroup<Record<string, FormControl>>({}));
  readonly fields = signal<InventoryField[]>([]);
  readonly customForm = signal(new FormRecord<FormControl>({}));
  readonly customFields = signal<InventoryCustomField[]>([]);
  readonly customValues = signal<Record<string, unknown>>({});
  readonly loadingFields = signal(false);
  readonly fieldLoadFailed = signal(false);
  readonly retiredFields = signal<string[]>([]);
  readonly confirmFieldRemoval = signal(false);
  readonly history = signal<DataGridRow[]>([]);
  readonly details = signal<Array<{ label: string; value: string }>>([]);
  search = '';
  sort = '';
  order: 'asc' | 'desc' = 'asc';
  searchName = '';
  scanTag = '';
  readonly lifecycle = signal<{ action: 'checkout' | 'checkin'; row: DataGridRow } | null>(null);
  selectedSearch: number | null = null;
  private applied: Record<string, string | number | boolean> = {};
  private loadSequence = 0;
  private formSequence = 0;
  private fieldSequence = 0;

  canReadFiles() {
    return this.isHardware ? this.auth.can('assets.files') : this.auth.can('assets.view') || this.canWriteFiles();
  }

  canWriteFiles() {
    return this.isHardware ? this.auth.can('assets.files') : this.auth.isSuperUser() ||
      this.auth.currentUser()?.keyPermissions?.['models.files'] === true;
  }

  private async openTag(tag: string) {
    try {
      const row = await this.api.read<DataGridRow>(`/hardware/bytag/${encodeURIComponent(tag)}`);
      if (typeof row.id === 'number') await this.open('view',row.id,row);
    } catch (error) { this.error.set(inventoryError(error)); }
  }

  async printSelected() {
    const selected = this.grid()?.selectedIds() ?? new Set();
    const tags = this.rows().filter((row) => row.id !== undefined && selected.has(row.id))
      .map((row) => String(row['asset_tag'] ?? '')).filter(Boolean);
    await this.printTags(tags);
  }

  async printTags(tags: string[]) {
    if (!tags.length) return;
    try {
      saveDownload(await this.api.postBlob('/hardware/labels',{ asset_tags:tags,format:'pdf' }),'asset-labels.pdf');
    } catch (error) { this.error.set(inventoryError(error)); }
  }

  ngOnInit(): void {
    const routeAction = this.route.snapshot.data['routeAction'];
    if (routeAction === 'bulk-checkout') {
      this.applied = { status: 'deployable' };
      this.message.set('Showing deployable assets. Select Check out on an asset row.');
    }
    void this.load();
    if (this.isHardware) void this.loadSearches();
    const tag = this.route.snapshot.paramMap.get('tag');
    const detail = Number(this.route.snapshot.paramMap.get('id') ?? this.route.snapshot.queryParamMap.get('detail'));
    if (routeAction === 'create') void this.open('edit');
    if (tag) void this.openTag(tag);
    if (detail > 0) void this.open('view', detail);
  }

  async selectDetailTab(
    tab: 'overview'|'orders'|'files'|'licenses'|'components'|'accessories'|'maintenances',
  ) {
    this.detailTab.set(tab);
    const id = this.recordId();
    if (!id || tab === 'overview' || tab === 'orders' || tab === 'files') return;
    this.detailSubRows.set([]);
    this.detailSubLoading.set(true);
    try {
      const path =
        tab === 'licenses'
          ? `/hardware/${id}/licenses`
          : tab === 'components'
            ? `/hardware/${id}/assigned/components`
            : tab === 'accessories'
              ? `/hardware/${id}/assigned/accessories`
              : '/maintenances';
      const query: Record<string, string | number> =
        tab === 'maintenances' ? { asset_id: id, limit: 50 } : { limit: 50 };
      const result = await this.api.records(path, query);
      this.detailSubRows.set(result.rows ?? []);
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.detailSubLoading.set(false);
    }
  }

  subCell(row: DataGridRow, keys: string[]): string {
    for (const key of keys) {
      const val = row[key];
      if (val !== null && val !== undefined && val !== '') return String(val);
    }
    return '—';
  }

  can(action: 'create' | 'edit' | 'delete'): boolean {
    return (
      this.auth.currentUser()?.isAdmin === true ||
      this.auth.can(permissionFor(this.permission, action))
    );
  }

  async load() {
    const sequence = ++this.loadSequence;
    this.loading.set(true);
    this.error.set('');
    try {
      const result = await this.api.records(this.path, {
        ...(this.deleted() ? {} : this.applied),
        limit: 20,
        page: this.page(),
        search: this.search,
        ...(this.sort ? { sort: this.sort } : {}),
        order: this.order,
        deleted: this.deleted() ? '1' : '0',
      });
      if (sequence !== this.loadSequence) return;
      this.rows.set(result.rows);
      this.total.set(result.total);
    } catch (error) {
      if (sequence === this.loadSequence) this.error.set(inventoryError(error));
    } finally {
      if (sequence === this.loadSequence) this.loading.set(false);
    }
  }

  searchChanged(search: string): void {
    this.grid()?.clearSelection();
    this.search = search;
    this.page.set(1);
    void this.load();
  }

  toggleDeleted() {
    this.grid()?.clearSelection();
    this.deleted.update((value) => !value);
    this.page.set(1);
    void this.load();
  }

  private activeFilters() {
    return Object.fromEntries(
      Object.entries(this.filterForm.getRawValue()).filter(
        ([, value]) => typeof value === 'number' || (typeof value === 'string' && value !== ''),
      ),
    );
  }

  applyFilters() {
    this.applied = this.activeFilters();
    this.page.set(1);
    void this.load();
  }
  clearFilters() {
    this.filterForm.reset();
    this.applyFilters();
  }

  private async loadSearches() {
    try {
      const [saved, result] = await Promise.all([
        this.api.read<{ rows: SavedSearch[] }>('/saved-searches'),
        this.api.read<{ fields: Array<{ db_column: string; name: string }> }>(
          '/hardware/custom-filter-fields',
          { limit: 100 },
        ),
      ]);
      this.savedSearches.set(saved.rows);
      this.filterable.set(result.fields);
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  async saveSearch() {
    try {
      await this.api.write('POST', '/saved-searches', {
        name: this.searchName.trim(),
        query: {
          ...this.activeFilters(),
          ...(this.search ? { search: this.search } : {}),
          ...(this.sort ? { sort: this.sort } : {}),
          order: this.order,
        },
      });
      this.searchName = '';
      await this.loadSearches();
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  useSearch() {
    const saved = this.savedSearches().find((item) => item.id === this.selectedSearch);
    if (!saved) return;
    const { search, sort, order, ...query } = saved.query;
    this.filterForm.reset(query);
    this.search = typeof search === 'string' ? search : '';
    this.sort = typeof sort === 'string' ? sort : '';
    this.order = order === 'desc' ? 'desc' : 'asc';
    this.applyFilters();
  }

  async deleteSearch() {
    if (this.selectedSearch === null) return;
    try {
      await this.api.write('DELETE', `/saved-searches/${this.selectedSearch}`);
      this.selectedSearch = null;
      await this.loadSearches();
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  private addFields(fields: InventoryField[], data: Record<string, unknown>, bulk: boolean) {
    const entries = fields.map((field) => {
      const value =
        field.type === 'date' && typeof data[field.key] === 'object'
          ? (data[field.key] as { date?: string } | null)?.date
          : data[field.key];
      return [
        field.key,
        new FormControl(
          value ?? (field.type === 'boolean' ? false : null),
          field.required && !bulk ? Validators.required : [],
        ),
      ];
    });
    this.fields.set(fields);
    const form = new FormGroup<Record<string, FormControl>>(Object.fromEntries(entries));
    this.form.set(form);
    return form;
  }

  async open(mode: DrawerMode, id?: number, row?: DataGridRow) {
    this.error.set('');
    this.message.set('');
    this.mode.set(mode);
    this.detailTab.set('overview');
    this.detailSubRows.set([]);
    this.detailTag.set('');
    this.recordId.set(id ?? null);
    this.customFields.set([]);
    this.customValues.set({});
    this.customForm.set(new FormRecord<FormControl>({}));
    this.loadingFields.set(false);
    this.fieldLoadFailed.set(false);
    this.retiredFields.set([]);
    this.confirmFieldRemoval.set(false);
    const generation = ++this.formSequence;
    try {
      const data =
        (mode === 'edit' || mode === 'view') && id !== undefined
          ? await this.api.read<DataGridRow>(`${this.path}/${id}`)
          : {};
      if (generation !== this.formSequence) return;
      if (mode === 'view') {
        const recordFields = this.isHardware ? assetFields : modelFields;
        const custom = data['custom_fields'] as Record<string, { value: unknown }> | undefined;
        this.detailTag.set(String(data['asset_tag'] ?? ''));
        this.details.set([
          ...(this.isHardware ? [
            { label: 'Book value', value: this.display(data['book_value']) },
            { label: 'Last audit', value: this.display(data['last_audit_date']) },
            { label: 'Next audit', value: this.display(data['next_audit_date']) },
          ] : []),
          ...recordFields.map(({ key, label }) => ({ label, value: this.display(data[key]) })),
          ...Object.entries(custom ?? {}).map(([label, item]) => ({
            label,
            value: this.display(item.value),
          })),
        ]);
        this.history.set(
          (await this.api.records(`${this.path}/${id}/history`, { limit: 20 })).rows,
        );
      } else if (mode === 'clone') {
        this.addFields(
          [{ key: 'name', label: 'New model name', required: true }],
          { name: typeof row?.['name'] === 'string' ? row['name'] + ' (copy)' : '' },
          false,
        );
      } else if (mode === 'edit' || mode === 'bulk_edit') {
        const active = this.isHardware ? assetFields : modelFields;
        const fields =
          mode === 'bulk_edit'
            ? active.filter(({ key }) => !['asset_tag', 'serial', 'name'].includes(key))
            : active.filter(({ key }) => key !== 'location_id' || data['assigned_type'] == null);
        const form = this.addFields(fields, data, mode === 'bulk_edit');
        if (this.isHardware) {
          const bulk = mode === 'bulk_edit';
          const records = bulk
            ? await Promise.all(
                this.ids().map((assetId) => this.api.read<AssetFormRecord>(`/hardware/${assetId}`)),
              )
            : id === undefined
              ? []
              : [data as AssetFormRecord];
          if (generation !== this.formSequence) return;
          const modelId = Number(form.controls['model_id']?.value);
          await this.loadAssetFields(modelId, generation, records, bulk);
          form.controls['model_id']?.valueChanges.subscribe((value) => {
            void this.loadAssetFields(Number(value), generation, records, bulk);
          });
        } else if (
          !this.isHardware &&
          id !== undefined &&
          typeof data['fieldset_id'] === 'number'
        ) {
          this.customFields.set(data['custom_field_schema'] as InventoryCustomField[]);
          this.customValues.set(
            await this.api.read<Record<string, unknown>>(
              `/fieldsets/${data['fieldset_id']}/fields/${id}`,
            ),
          );
        }
      }
      if (generation !== this.formSequence) return;
      this.drawerTitle.set(
        mode === 'view'
          ? 'Record details'
          : mode === 'clone'
            ? 'Clone model'
            : mode === 'delete'
              ? 'Delete records'
              : mode === 'restore'
                ? 'Restore records'
                : mode === 'bulk_edit'
                  ? 'Bulk edit'
                  : id === undefined
                    ? 'Create record'
                    : 'Edit record',
      );
      this.drawer.set(true);
    } catch (error) {
      if (generation === this.formSequence) this.error.set(inventoryError(error));
    }
  }

  private async loadAssetFields(
    modelId: number,
    generation: number,
    records: AssetFormRecord[],
    bulk: boolean,
  ) {
    if (generation !== this.formSequence) return;
    const request = ++this.fieldSequence;
    const isCurrent = () => generation === this.formSequence && request === this.fieldSequence;
    this.error.set('');
    this.fieldLoadFailed.set(false);
    this.customFields.set([]);
    this.customValues.set({});
    this.retiredFields.set([]);
    this.confirmFieldRemoval.set(false);

    const first = records[0];
    const commonFields = (first?.custom_field_schema ?? []).filter(({ db_column }) =>
      records.every((record) =>
        record.custom_field_schema.some((field) => field.db_column === db_column),
      ),
    );
    let fields = commonFields;
    let defaults: Record<string, unknown> = {};
    const modelChanged = modelId > 0 && records.some((record) => modelId !== record.model_id);
    if (modelId && (!first || modelChanged)) {
      this.loadingFields.set(true);
      try {
        const data = await this.api.read<{
          fields: InventoryCustomField[];
          defaults: Record<string, unknown>;
        }>(`/hardware/form/${modelId}`);
        if (!isCurrent()) return;
        fields = data.fields;
        defaults = data.defaults;
      } catch (error) {
        if (isCurrent()) {
          this.error.set(inventoryError(error));
          this.fieldLoadFailed.set(true);
        }
        return;
      } finally {
        if (isCurrent()) this.loadingFields.set(false);
      }
    }
    this.loadingFields.set(false);

    const keys = new Set(fields.map(({ db_column }) => db_column));
    if (modelChanged) {
      const retired = records
        .flatMap((record) => record.custom_field_schema)
        .filter(({ db_column }) => !keys.has(db_column))
        .map(({ name }) => name);
      this.retiredFields.set([...new Set(retired)]);
    }
    if (bulk) {
      this.customFields.set(fields.map((field) => ({ ...field, required: false })));
    } else {
      const values = Object.values(first?.custom_fields ?? {}).filter(
        ({ field, value }) => keys.has(field) && value != null,
      );
      this.customFields.set(fields);
      this.customValues.set({
        ...defaults,
        ...Object.fromEntries(values.map(({ field, value }) => [field, value])),
      });
    }
  }

  act(event: { action: DataGridActionType; row: DataGridRow }): void {
    if (typeof event.row.id !== 'number') return;
    if (event.action === 'request' || event.action === 'cancel') return;
    if (event.action === 'files') return;
    if (event.action === 'audit') {
      void this.openAudit(event.row.id);
      return;
    }
    const mode = event.action === 'update' ? 'edit' : event.action;
    if (mode === 'checkout' || mode === 'checkin') {
      this.lifecycle.set({ action: mode, row: event.row });
      return;
    }
    this.ids.set([event.row.id]);
    void this.open(mode, event.row.id, event.row);
  }

  canAudit(): boolean {
    return this.auth.isSuperUser() || this.auth.currentUser()?.keyPermissions?.['assets.audit'] === true;
  }

  async openAudit(id: number) {
    try {
      this.audit.set({ asset: await this.api.read<DataGridRow>(`/hardware/${id}/audit`), ids: [] });
    } catch (error) { this.error.set(inventoryError(error)); }
  }

  auditClosed() {
    this.audit.set(null);
    this.grid()?.clearSelection();
    void this.load();
  }

  auditSaved(message: string) {
    this.message.set(message);
    this.auditClosed();
  }

  async downloadAudit(row: DataGridRow) {
    try {
      const blob = await this.api.blob(`/hardware/${this.recordId()}/audits/${row.id}/photo`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `audit-${row.id}.${blob.type === 'image/png' ? 'png' : 'jpg'}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { this.error.set(inventoryError(error)); }
  }

  canCheckin(): boolean {
    const user = this.auth.currentUser();
    return !!user && (user.isSuperUser || user.keyPermissions?.['assets.checkin'] === true);
  }

  async scan(): Promise<void> {
    this.error.set('');
    try {
      const row = await this.api.read<DataGridRow>(
        `/hardware/bytag/${encodeURIComponent(this.scanTag.trim())}`,
      );
      this.lifecycle.set({ action: 'checkin', row });
      this.scanTag = '';
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  lifecycleSaved(message: string): void {
    this.lifecycle.set(null);
    this.message.set(message);
    void this.load();
  }

  bulk(event: { action: string; selectedIds: Array<number | string> }) {
    if (event.selectedIds.length > 100) {
      this.error.set('Select up to 100 assets for a bulk change.');
      return;
    }
    if (event.action === 'bulk_audit') {
      this.audit.set({ ids: event.selectedIds.map(Number) });
      return;
    }
    this.ids.set(event.selectedIds.map(Number));
    void this.open(
      event.action === 'bulk_restore'
        ? 'restore'
        : event.action === 'bulk_delete'
          ? 'delete'
          : 'bulk_edit',
    );
  }

  async save() {
    const mode = this.mode();
    const id = this.recordId();
    if (this.saving() || this.loadingFields() || this.fieldLoadFailed() || mode === 'view') return;
    this.error.set('');
    const values = Object.fromEntries(
      Object.entries(this.form().controls)
        .filter(
          ([key, control]) =>
            control.dirty ||
            mode === 'clone' ||
            (mode === 'edit' &&
              id === null &&
              this.fields().some((item) => item.key === key && item.required)),
        )
        .map(([key, control]) => [key, control.value === '' ? null : control.value]),
    );
    const custom = customFieldChanges(this.customForm(), this.customFields());
    if (this.retiredFields().length) {
      if (!this.confirmFieldRemoval()) {
        this.error.set('Confirm removal of saved custom values before changing models.');
        return;
      }
      values['confirm_custom_field_removal'] = true;
    }
    if (this.isHardware && Object.keys(custom).length) values['custom_fields'] = custom;
    if (mode === 'bulk_edit' && Object.keys(values).length === 0) {
      this.error.set('Change at least one field.');
      return;
    }
    if (
      ['clone', 'edit', 'bulk_edit'].includes(mode) &&
      (this.form().invalid || this.customForm().invalid)
    ) {
      this.error.set('Enter all required values.');
      return;
    }
    this.saving.set(true);
    try {
      if (mode === 'delete' || mode === 'restore') {
        if (this.isHardware)
          await this.api.write('PATCH', '/hardware/bulk', { action: mode, ids: this.ids() });
        else if (mode === 'delete') await this.api.write('DELETE', `${this.path}/${id}`);
        else await this.api.write('POST', `${this.path}/${id}/restore`, {});
      } else if (mode === 'clone') {
        await this.api.write('POST', `${this.path}/${id}/clone`, values);
      } else if (mode === 'bulk_edit') {
        await this.api.write('PATCH', '/hardware/bulk', {
          action: 'edit',
          ids: this.ids(),
          changes: values,
        });
      } else {
        if (id === null || Object.keys(values).length) {
          await this.api.write(
            id === null ? 'POST' : 'PATCH',
            id === null ? this.path : `${this.path}/${id}`,
            values,
          );
        }
        if (!this.isHardware && id !== null && Object.keys(custom).length) {
          const fieldsetId = this.form().controls['fieldset_id']?.value;
          await this.api.write('POST', `/fieldsets/${fieldsetId}/fields/${id}`, custom);
        }
      }
      this.drawer.set(false);
      this.grid()?.clearSelection();
      this.message.set('Changes saved.');
      await this.load();
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.saving.set(false);
    }
  }

  display(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      return String(value);
    if (
      value &&
      typeof value === 'object' &&
      'formatted' in value &&
      typeof value.formatted === 'string'
    )
      return value.formatted;
    if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
      return value.join(', ');
    return '—';
  }
}

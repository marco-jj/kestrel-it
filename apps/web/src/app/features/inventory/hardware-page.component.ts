import { Component, OnInit, inject, signal } from '@angular/core';
import {
  FormControl,
  FormGroup,
  FormRecord,
  FormsModule,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
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
    <kestrel-data-grid
      [columns]="columns"
      [rows]="rows()"
      [total]="total()"
      [page]="page()"
      [loading]="loading()"
      [creatable]="can('create') && !deleted()"
      [selectable]="isHardware && (can('edit') || can('delete'))"
      [bulkEdit]="!deleted() && can('edit')"
      [bulkDelete]="!deleted() && can('delete')"
      [bulkRestore]="deleted() && can('delete')"
      (createClicked)="open('edit')"
      (rowAction)="act($event)"
      (bulkAction)="bulk($event)"
      (searchChanged)="search = $event; page.set(1); load()"
      (sortChanged)="sort = $event.sort; order = $event.order; load()"
      (pageChanged)="page.set($event); load()"
    />
    <kestrel-slide-drawer
      [open]="drawer()"
      [title]="drawerTitle()"
      size="xl"
      (closed)="drawer.set(false)"
    >
      @if (drawer()) {
        @switch (mode()) {
          @case ('view') {
            <dl>
              @for (item of details(); track item.label) {
                <dt>{{ item.label }}</dt>
                <dd>{{ item.value }}</dd>
              }
            </dl>
            <h2>History</h2>
            <ul>
              @for (item of history(); track item.id) {
                <li>{{ item['action_type'] }} · {{ display(item['action_date']) }}</li>
              } @empty {
                <li>No activity recorded.</li>
              }
            </ul>
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
              @if (customFields().length && (isHardware || recordId())) {
                <kestrel-custom-field-form-section
                  [form]="customForm()"
                  [fields]="customFields()"
                  [values]="customValues()"
                  [defaultsOnly]="!isHardware"
                />
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
              [disabled]="saving()"
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
  readonly isHardware = inject(ActivatedRoute).snapshot.routeConfig?.path === 'hardware';
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
  private originalModel: number | null = null;
  private originalCustom: Record<string, unknown> = {};

  ngOnInit(): void {
    void this.load();
    if (this.isHardware) void this.loadSearches();
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

  toggleDeleted() {
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
    this.recordId.set(id ?? null);
    this.customFields.set([]);
    this.customValues.set({});
    this.customForm.set(new FormRecord<FormControl>({}));
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
        this.details.set([
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
        this.originalModel = typeof data['model_id'] === 'number' ? data['model_id'] : null;
        const stored = data['custom_fields'] as
          Record<string, { field: string; value: unknown }> | undefined;
        this.originalCustom = Object.fromEntries(
          Object.values(stored ?? {}).map((item) => [item.field, item.value]),
        );
        if (mode === 'edit' && this.isHardware) {
          if (this.originalModel) await this.loadAssetFields(this.originalModel, generation);
          form.controls['model_id']?.valueChanges.subscribe((value) => {
            void this.loadAssetFields(Number(value), generation);
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

  private async loadAssetFields(modelId: number, generation: number) {
    const form = this.form();
    if (!modelId) {
      if (generation === this.formSequence) this.customFields.set([]);
      return;
    }
    try {
      const data = await this.api.read<{
        fields: InventoryCustomField[];
        defaults: Record<string, unknown>;
      }>(`/hardware/form/${modelId}`);
      if (generation !== this.formSequence || Number(form.controls['model_id']?.value) !== modelId)
        return;
      this.customFields.set(data.fields);
      this.customValues.set(
        this.recordId() === null
          ? data.defaults
          : modelId === this.originalModel
            ? this.originalCustom
            : {},
      );
    } catch (error) {
      if (generation === this.formSequence) this.error.set(inventoryError(error));
    }
  }

  act(event: { action: DataGridActionType; row: DataGridRow }): void {
    if (typeof event.row.id !== 'number') return;
    if (event.action === 'request' || event.action === 'cancel') return;
    const mode = event.action === 'update' ? 'edit' : event.action;
    if (mode === 'checkout' || mode === 'checkin') {
      this.lifecycle.set({ action: mode, row: event.row });
      return;
    }
    this.ids.set([event.row.id]);
    void this.open(mode, event.row.id, event.row);
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
    if (this.saving() || mode === 'view') return;
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
        if (this.isHardware && Object.keys(custom).length) values['custom_fields'] = custom;
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

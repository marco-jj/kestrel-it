import type { PermissionKey } from '@kestrel-it/shared';
import { InventoryFilesComponent } from './inventory-files.component.js';
import { Component, OnInit, inject, signal, viewChild } from '@angular/core';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { KIT_RESOURCES, SECONDARY_RESOURCES, type KitResource } from '@kestrel-it/shared';
import { AuthStore } from '../../core/auth/auth.store.js';
import {
  KestrelDataGridComponent,
  type DataGridActionType,
  type DataGridRow,
} from '../../shared/ui/data-grid.component.js';
import { KestrelSlideDrawerComponent } from '../../shared/ui/slide-drawer.component.js';
import { field, permissionFor, reference, type InventoryField } from './directory-ui.js';
import { InventoryApi, inventoryError } from './inventory-api.js';
import { InventoryFormFieldsComponent } from './inventory-form-fields.component.js';
import { OrderItemsComponent } from './order-items.component.js';
import {
  inventoryForm,
  phaseThreeDefinitions,
  required,
  type PhaseThreeResource,
} from './phase-three-ui.js';

type Operation =
  | 'edit'
  | 'bulkedit'
  | 'delete'
  | 'restore'
  | 'unarchive'
  | 'checkout'
  | 'checkin'
  | 'adjust'
  | 'consume'
  | 'complete'
  | 'note'
  | 'add-line'
  | 'edit-line'
  | 'remove-line';
type DetailTab = 'Overview' | 'Assignments' | 'History' | 'Orders' | 'Composition' | 'Notes' | 'Files';
const itemTypes = {
  licenses: 'license',
  accessories: 'accessory',
  consumables: 'consumable',
  components: 'component',
};
const assignmentPaths = {
  licenses: 'seats',
  accessories: 'checkedout',
  consumables: 'users',
  components: 'assets',
};
const adjustmentFields = [
  required(field('amount', 'Quantity adjustment', 'number')),
  field('note', 'Reason', 'textarea'),
  field('order_number', 'Order number'),
  reference('supplier_id', 'Supplier', 'suppliers'),
  field('unit_cost', 'Unit cost'),
  field('currency', 'Currency'),
  field('purchase_date', 'Purchase date', 'date'),
];

@Component({
  selector: 'kestrel-phase-three-page',
  standalone: true,
  imports: [
    FormsModule,
    ReactiveFormsModule,
    RouterLink,
    InventoryFormFieldsComponent,
    KestrelDataGridComponent,
    KestrelSlideDrawerComponent,
    OrderItemsComponent,
    InventoryFilesComponent,
  ],
  template: `
    <header class="toolbar">
      <h1>{{ definition.title }}</h1>
      @if (isSecondary && can('delete')) {
        <button class="k-btn k-btn-secondary" (click)="toggleDeleted()">
          {{ deleted() ? 'Show active records' : 'Show deleted records' }}
        </button>
      }
      @if (resource === 'maintenances') {
        <a class="k-btn k-btn-secondary" routerLink="/maintenance-types">Maintenance types</a>
      }
    </header>
    @if (message()) {
      <p role="status">{{ message() }}</p>
    }
    @if (error() && !drawer()) {
      <p role="alert">{{ error() }}</p>
    }
    <kestrel-data-grid
      [rows]="rows()"
      [columns]="columns"
      [page]="page()"
      [total]="total()"
      [loading]="loading()"
      [creatable]="can('create') && !deleted()"
      [selectable]="isSecondary && (can('edit') || can('delete'))"
      [bulkEdit]="isSecondary && can('edit') && !deleted()"
      [bulkDelete]="isSecondary && can('delete') && !deleted()"
      [bulkRestore]="isSecondary && can('delete') && deleted()"
      (createClicked)="openOperation('edit')"
      (rowAction)="act($event)"
      (bulkAction)="bulk($event)"
      (searchChanged)="search = $event; page.set(1); load()"
      (pageChanged)="page.set($event); load()"
      (sortChanged)="order = $event.order; load()"
    />
    <kestrel-slide-drawer [open]="drawer()" [title]="drawerTitle()" size="xl" (closed)="close()">
      @if (drawer()) {
        @if (operation() === null && current(); as row) {
          <nav class="toolbar tabs" aria-label="Record details">
            @for (tab of tabs; track tab) {
              <button
                class="k-btn"
                [class.k-btn-secondary]="tab === activeTab()"
                [attr.aria-pressed]="tab === activeTab()"
                (click)="showTab(tab)"
              >
                {{ tab }}
              </button>
            }
          </nav>
          @if (activeTab() === 'Overview') {
            <dl>
              @for (item of detailFields(row); track item.label) {
                <dt>{{ item.label }}</dt>
                <dd>{{ item.value }}</dd>
              }
            </dl>
            <div class="toolbar">
              @if (isSecondary && resource !== 'licenses' && can('edit') && !row['archived']) {
                <button class="k-btn k-btn-secondary" (click)="openOperation('adjust', row)">
                  Adjust quantity
                </button>
              }
              @if (row['archived'] && can('edit')) {
                <button class="k-btn k-btn-secondary" (click)="openOperation('unarchive', row)">
                  Unarchive
                </button>
              }
              @if ((resource === 'kits' && kitCheckout) || row.available_actions?.checkout) {
                <button class="k-btn k-btn-primary" (click)="openOperation('checkout', row)">
                  Check out
                </button>
              }
              @if (resource === 'maintenances' && can('edit') && !row['completed_at']) {
                <button class="k-btn k-btn-primary" (click)="openOperation('complete', row)">
                  Complete maintenance
                </button>
              }
            </div>
          }
          @if (activeTab() === 'Files' && currentId()) {
            <kestrel-inventory-files [resource]="resource" [itemId]="currentId()!" [canWrite]="true" />
          }
          @if (activeTab() === 'Orders' && itemType && currentId()) {
            <kestrel-order-items [itemId]="currentId()!" [itemType]="itemType" />
          }
          @if (activeTab() === 'Composition') {
            @for (kind of kitKinds; track kind) {
              <section class="related-section">
                <div class="toolbar">
                  <h2>{{ kitTitles[kind] }}</h2>
                  @if (can('edit')) {
                    <button class="k-btn k-btn-secondary" (click)="line('add-line', kind)">
                      Add {{ itemName[kind] }}
                    </button>
                  }
                </div>
                @for (entry of composition()[kind]; track entry.id) {
                  <div class="related-row">
                    <span>{{ entry['name'] || '#' + entry.id }} · {{ entry['quantity'] }}</span>
                    @if (can('edit')) {
                      <button
                        class="k-btn k-btn-secondary"
                        (click)="line('edit-line', kind, entry)"
                      >
                        Edit quantity
                      </button>
                      <button class="k-btn k-btn-ghost" (click)="line('remove-line', kind, entry)">
                        Remove
                      </button>
                    }
                  </div>
                } @empty {
                  <p>No items.</p>
                }
              </section>
            }
          }
          @if (
            activeTab() === 'Assignments' || activeTab() === 'History' || activeTab() === 'Notes'
          ) {
            @if (activeTab() === 'Notes' && can('edit')) {
              <button class="k-btn k-btn-secondary" (click)="openOperation('note', row)">
                Add note
              </button>
            }
            @for (entry of related(); track entry.id) {
              <div class="related-row">
                <span>{{ relatedLabel(entry) }}</span>
                @if (activeTab() === 'Assignments') {
                  @if (resource === 'consumables' && !entry['consumed_at'] && direct('checkout')) {
                    <button
                      class="k-btn k-btn-secondary"
                      (click)="openOperation('consume', row, entry)"
                    >
                      Mark consumed
                    </button>
                  }
                  @if (
                    resource !== 'consumables' &&
                    direct('checkin') &&
                    (resource !== 'licenses' || entry['occupied'])
                  ) {
                    <button
                      class="k-btn k-btn-secondary"
                      (click)="openOperation('checkin', row, entry)"
                    >
                      Check in
                    </button>
                  }
                  @if (
                    resource === 'licenses' &&
                    !entry['unreassignable_seat'] &&
                    direct('checkout') &&
                    (!entry['occupied'] || (row['reassignable'] && direct('checkin')))
                  ) {
                    <button
                      class="k-btn k-btn-secondary"
                      (click)="openOperation('checkout', row, entry)"
                    >
                      {{ entry['occupied'] ? 'Reassign seat' : 'Check out seat' }}
                    </button>
                  }
                }
              </div>
            } @empty {
              <p>No records.</p>
            }
            @if (relatedPage() > 1 || relatedTotal() > 20) {
              <div class="toolbar">
                <button
                  class="k-btn k-btn-secondary"
                  [disabled]="relatedPage() <= 1"
                  (click)="relatedPage.set(relatedPage() - 1); loadRelated()"
                >
                  Previous
                </button>
                <button
                  class="k-btn k-btn-secondary"
                  [disabled]="relatedPage() * 20 >= relatedTotal()"
                  (click)="relatedPage.set(relatedPage() + 1); loadRelated()"
                >
                  Next
                </button>
              </div>
            }
          }
        } @else {
          <form [formGroup]="form()" (ngSubmit)="submit()">
            @if (operation() === 'checkout' && targets.length > 1) {
              <label
                >Assign to
                <select
                  [ngModel]="target"
                  (ngModelChange)="changeTarget($event)"
                  [ngModelOptions]="{ standalone: true }"
                >
                  @for (type of targets; track type) {
                    <option [value]="type">{{ targetLabels[type] }}</option>
                  }
                </select>
              </label>
            }
            @if (formFields().length) {
              <kestrel-inventory-form-fields
                [form]="form()"
                [fields]="formFields()"
                [companyId]="companyId"
              />
            } @else {
              <p>{{ confirmation() }}</p>
            }
            <div class="toolbar footer">
              <button class="k-btn k-btn-secondary" type="button" (click)="back()">Cancel</button>
              <button class="k-btn k-btn-primary" [disabled]="saving()" type="submit">
                {{ submitLabel() }}
              </button>
            </div>
          </form>
        }
        @if (error()) {
          <p role="alert">{{ error() }}</p>
        }
      }
    </kestrel-slide-drawer>
  `,
  styles: [
    `
      h1 {
        font-size: 1.6rem;
        font-weight: 640;
        margin-right: auto;
      }
      h2 {
        font-weight: 600;
        margin-right: auto;
      }
      .toolbar,
      .related-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.65rem;
        margin-block: 0 0.85rem;
      }
      .tabs {
        border-bottom: 1px solid var(--kestrel-border);
        padding-bottom: 0.6rem;
      }
      .related-section {
        padding-block: 0.75rem;
      }
      .related-row {
        padding: 0.5rem 0;
        border-bottom: 1px solid var(--kestrel-border);
      }
      .related-row span {
        flex: 1 1 12rem;
      }
      dl {
        display: grid;
        grid-template-columns: minmax(8rem, 1fr) 2fr;
        gap: 0.45rem 0.85rem;
        margin-bottom: 1rem;
      }
      dt {
        color: var(--kestrel-muted);
      }
      dd {
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }
      .footer {
        justify-content: flex-end;
        margin-top: 1.1rem;
      }
      [role='alert'] {
        color: var(--kestrel-danger);
      }
      select {
        border: 1px solid var(--kestrel-border);
        border-radius: 0.4rem;
        margin: 0.4rem;
        padding: 0.4rem;
      }
    `,
  ],
})
export class PhaseThreePageComponent implements OnInit {
  private readonly api = inject(InventoryApi);
  private readonly auth = inject(AuthStore);
  private readonly route = inject(ActivatedRoute);
  private readonly grid = viewChild(KestrelDataGridComponent);
  readonly resource = this.route.snapshot.data['resource'] as PhaseThreeResource;
  readonly definition = phaseThreeDefinitions[this.resource];
  readonly isSecondary = SECONDARY_RESOURCES.some((resource) => resource === this.resource);
  readonly itemType = itemTypes[this.resource as keyof typeof itemTypes];
  readonly columns = [{ key: 'name', label: 'Name' }, ...this.definition.columns];
  readonly rows = signal<DataGridRow[]>([]);
  readonly drawer = signal(false);
  readonly current = signal<DataGridRow | null>(null);
  readonly currentId = signal<number | null>(null);
  readonly operation = signal<Operation | null>(null);
  readonly formFields = signal<InventoryField[]>([]);
  readonly form = signal(inventoryForm([]));
  readonly drawerTitle = signal('');
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly message = signal('');
  readonly error = signal('');
  readonly deleted = signal(false);
  readonly page = signal(1);
  readonly total = signal(0);
  readonly activeTab = signal<DetailTab>('Overview');
  readonly related = signal<DataGridRow[]>([]);
  readonly relatedPage = signal(1);
  readonly relatedTotal = signal(0);
  readonly composition = signal<Partial<Record<KitResource, DataGridRow[]>>>({});
  readonly kitKinds = KIT_RESOURCES;
  readonly kitTitles = {
    models: 'Asset models',
    licenses: 'Licenses',
    accessories: 'Accessories',
    consumables: 'Consumables',
  };
  readonly itemName = {
    models: 'model',
    licenses: 'license',
    accessories: 'accessory',
    consumables: 'consumable',
  };
  readonly targetLabels = { user: 'User', asset: 'Asset', location: 'Location' };
  search = '';
  order: 'asc' | 'desc' = 'asc';
  target: keyof typeof this.targetLabels = 'user';
  private ids: number[] = [];
  private entry: DataGridRow | null = null;
  private kitKind: KitResource = 'models';
  private loadSequence = 0;
  private detailSequence = 0;
  private fromDetail = false;

  get targets(): Array<keyof typeof this.targetLabels> {
    if (this.resource === 'accessories') return ['user', 'asset', 'location'];
    if (this.resource === 'licenses') return ['user', 'asset'];
    return this.resource === 'components' ? ['asset'] : ['user'];
  }

  canFiles() {
    if (this.resource === 'maintenances') return this.auth.can('assets.edit');
    return this.isSecondary && this.auth.can(`${this.resource}.files` as PermissionKey);
  }

  get tabs(): DetailTab[] {
    if (this.isSecondary) return ['Overview', 'Assignments', 'History', 'Orders', ...(this.canFiles() ? ['Files' as const] : [])];
    if (this.resource === 'kits') return ['Overview', 'Composition'];
    if (this.resource === 'maintenances') return ['Overview', 'History', 'Notes', ...(this.canFiles() ? ['Files' as const] : [])];
    return ['Overview'];
  }

  get companyId() {
    const id = this.current()?.['company_id'];
    return this.operation() === 'checkout' && (id === null || typeof id === 'number')
      ? id
      : undefined;
  }

  ngOnInit(): void {
    void this.load();
    const detail = Number(this.route.snapshot.queryParamMap.get('detail'));
    if (detail > 0) void this.openDetail(detail);
  }

  can(action: 'view' | 'create' | 'edit' | 'delete') {
    if (this.resource === 'maintenance-types')
      return action === 'view' ? this.auth.can('assets.view') : this.auth.isSuperUser();
    const resource = this.resource === 'maintenances' ? 'assets' : this.resource;
    const key = this.resource === 'maintenances' && action !== 'view' ? 'edit' : action;
    return this.auth.isAdmin() || this.auth.can(permissionFor(resource, key));
  }

  get kitCheckout() {
    return (
      this.auth.isSuperUser() ||
      (
        [
          'assets.checkout',
          'licenses.checkout',
          'accessories.checkout',
          'consumables.checkout',
        ] as const
      ).some((permission) => this.auth.currentUser()?.keyPermissions?.[permission] === true)
    );
  }

  direct(action: 'checkout' | 'checkin') {
    return (
      this.auth.isSuperUser() ||
      this.auth.currentUser()?.keyPermissions?.[permissionFor(this.resource, action)] === true
    );
  }

  async load() {
    const sequence = ++this.loadSequence;
    this.loading.set(true);
    try {
      const result = await this.api.records('/' + this.resource, {
        page: this.page(),
        limit: 20,
        search: this.search,
        order: this.order,
        ...(this.isSecondary ? { deleted: this.deleted() ? '1' : '0' } : {}),
      });
      if (sequence !== this.loadSequence) return;
      this.rows.set(result.rows.map((row) => ({ ...row, available_actions: this.actions(row) })));
      this.total.set(result.total);
    } catch (error) {
      if (sequence === this.loadSequence) this.error.set(inventoryError(error));
    } finally {
      if (sequence === this.loadSequence) this.loading.set(false);
    }
  }

  private actions(row: DataGridRow) {
    if (this.deleted()) return { restore: this.can('delete') };
    return {
      view: true,
      update: this.can('edit') && !row['is_system'],
      delete: this.can('delete') && !row['is_system'] && row.available_actions?.delete !== false,
      checkout: row.available_actions?.checkout || (this.resource === 'kits' && this.kitCheckout),
    };
  }

  toggleDeleted() {
    this.deleted.update((value) => !value);
    this.page.set(1);
    this.grid()?.clearSelection();
    void this.load();
  }

  act(event: { action: DataGridActionType; row: DataGridRow }) {
    if (typeof event.row.id !== 'number') return;
    switch (event.action) {
      case 'view':
        void this.openDetail(event.row.id);
        break;
      case 'update':
        void this.edit(event.row.id);
        break;
      case 'delete':
      case 'restore':
      case 'checkout':
        this.openOperation(event.action, event.row);
        break;
    }
  }

  bulk(event: { action: string; selectedIds: Array<number | string> }) {
    this.openOperation(
      event.action === 'bulk_edit'
        ? 'bulkedit'
        : event.action === 'bulk_restore'
          ? 'restore'
          : 'delete',
    );
    this.ids = event.selectedIds.map(Number);
  }

  private async edit(id: number) {
    try {
      this.openOperation('edit', await this.api.read<DataGridRow>(`/${this.resource}/${id}`));
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  async openDetail(id: number) {
    const sequence = ++this.detailSequence;
    this.error.set('');
    try {
      const row = await this.api.read<DataGridRow>(`/${this.resource}/${id}`);
      if (sequence !== this.detailSequence) return;
      this.current.set(row);
      this.currentId.set(id);
      this.activeTab.set('Overview');
      this.drawerTitle.set(String(row['name']));
      this.operation.set(null);
      this.drawer.set(true);
    } catch (error) {
      if (sequence === this.detailSequence) this.error.set(inventoryError(error));
    }
  }

  detailFields(row: DataGridRow) {
    const fields = [
      ...this.definition.fields.filter(({ key }) => key !== 'name'),
      ...(this.isSecondary ? [field('remaining', 'Available')] : []),
      field('book_value', 'Book value'),
      field('completed_at', 'Completed'),
    ];
    return fields
      .filter(({ key }) => row[key] !== undefined && row[key] !== null)
      .map(({ key, label }) => ({
        label,
        value: typeof row[key] === 'boolean' ? (row[key] ? 'Yes' : 'No') : String(row[key]),
      }));
  }

  showTab(tab: DetailTab) {
    this.activeTab.set(tab);
    this.relatedPage.set(1);
    this.related.set([]);
    if (tab === 'Composition' || tab === 'Assignments' || tab === 'History' || tab === 'Notes')
      void this.loadRelated();
  }

  async loadRelated() {
    const id = this.currentId();
    const tab = this.activeTab();
    if (id === null) return;
    this.error.set('');
    try {
      const url = `/${this.resource}/${id}`;
      if (tab === 'Composition') {
        const lines = await Promise.all(
          KIT_RESOURCES.map(
            async (kind) => [kind, await this.api.read<DataGridRow[]>(url + '/' + kind)] as const,
          ),
        );
        if (id === this.currentId() && tab === this.activeTab())
          this.composition.set(Object.fromEntries(lines));
        return;
      }
      const endpoint =
        tab === 'Assignments'
          ? assignmentPaths[this.resource as keyof typeof assignmentPaths]
          : tab.toLowerCase();
      const response = await this.api.records(url + '/' + endpoint, {
        page: this.relatedPage(),
        limit: 20,
      });
      if (id === this.currentId() && tab === this.activeTab()) {
        this.related.set(response.rows);
        this.relatedTotal.set(response.total);
      }
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  relatedLabel(row: DataGridRow) {
    if (this.activeTab() === 'Assignments') {
      return [
        this.resource === 'licenses' ? `Seat #${row.id}` : `Assignment #${row.id}`,
        row['unreassignable_seat'] ? 'Retired' : row['occupied'] === false ? 'Available' : '',
        row['quantity'] ? `Quantity ${row['quantity']}` : '',
        row['consumed_at'] ? 'Consumed' : '',
        row['asset_id'] ? `Asset #${row['asset_id']}` : '',
        row['assigned_to'] ? `User #${row['assigned_to']}` : '',
        row['target_id'] ? `${row['target_type']} #${row['target_id']}` : '',
        row['note'],
      ]
        .filter(Boolean)
        .join(' · ');
    }
    return [
      row['action_type'],
      typeof row['action_date'] === 'string' ? new Date(row['action_date']).toLocaleString() : '',
      row['quantity'] && this.isSecondary ? `Quantity ${row['quantity']}` : '',
      row['note'],
    ]
      .filter(Boolean)
      .join(' · ');
  }

  openOperation(operation: Operation, row?: DataGridRow, entry?: DataGridRow) {
    this.fromDetail = this.drawer() && this.operation() === null;
    this.error.set('');
    this.operation.set(operation);
    this.current.set(row ?? null);
    this.currentId.set(typeof row?.id === 'number' ? row.id : null);
    this.entry = entry ?? null;
    this.ids = this.currentId() !== null ? [this.currentId()!] : [];
    this.target = this.targets[0]!;
    this.drawerTitle.set(this.submitLabel());
    const values: DataGridRow =
      operation === 'edit'
        ? (row ?? {
            qty: 0,
            seats: 1,
            reassignable: true,
            start_date: new Date().toISOString().slice(0, 10),
            depreciation_type: 'amount',
            fiscal_year_start_month: 1,
          })
        : { quantity: entry?.['quantity'] ?? 1 };
    this.setForm(operation, values);
    this.drawer.set(true);
  }

  private setForm(operation: Operation, values: DataGridRow) {
    let fields: InventoryField[] = [];
    if (operation === 'edit' || operation === 'bulkedit') {
      fields = this.definition.fields.filter(
        ({ key }) =>
          (key !== 'qty' || (!this.currentId() && operation === 'edit')) &&
          (key !== 'asset_id' || !this.currentId()) &&
          (key !== 'serial' ||
            this.resource !== 'licenses' ||
            this.auth.isSuperUser() ||
            this.auth.currentUser()?.keyPermissions?.['licenses.keys']),
      );
      if (operation === 'bulkedit')
        fields = fields.map((config) => ({ ...config, required: false }));
    } else if (operation === 'checkout') {
      const target = this.target;
      const control = this.resource === 'kits' ? 'user_id' : 'target_id';
      const resource = { user: 'users', asset: 'hardware', location: 'locations' }[target];
      const path =
        this.resource === 'kits' ? '/kits/targets/users' : `/${this.resource}/targets/${target}`;
      fields = [
        required({ ...reference(control, this.targetLabels[target], resource), optionsPath: path }),
        ...(this.resource === 'kits' || this.entry
          ? []
          : [required(field('quantity', 'Quantity', 'number'))]),
        field('note', 'Note', 'textarea'),
      ];
    } else if (operation === 'checkin') {
      fields = [
        ...(this.resource === 'components'
          ? [required(field('quantity', 'Quantity to return', 'number'))]
          : []),
        field('note', 'Note', 'textarea'),
      ];
    } else if (operation === 'adjust') fields = adjustmentFields;
    else if (operation === 'note' || operation === 'complete') {
      fields = [
        operation === 'note'
          ? required(field('note', 'Note', 'textarea'))
          : field('note', 'Completion note', 'textarea'),
      ];
    } else if (operation === 'add-line' || operation === 'edit-line') {
      fields = [
        ...(operation === 'add-line'
          ? [required(reference('item_id', this.kitTitles[this.kitKind], this.kitKind))]
          : []),
        required(field('quantity', 'Quantity', 'number')),
      ];
    }
    this.formFields.set(fields);
    this.form.set(inventoryForm(fields, values));
  }

  changeTarget(target: keyof typeof this.targetLabels) {
    const values = this.form().getRawValue();
    this.target = target;
    this.setForm('checkout', { ...values, target_id: null });
  }

  line(
    operation: 'add-line' | 'edit-line' | 'remove-line',
    kind: KitResource,
    entry?: DataGridRow,
  ) {
    this.kitKind = kind;
    this.openOperation(operation, this.current() ?? undefined, entry);
  }

  confirmation() {
    return this.ids.length > 1
      ? `Apply this action to ${this.ids.length} selected records?`
      : 'Confirm this action?';
  }

  submitLabel() {
    const action = this.operation();
    if (action === null) return '';
    return {
      edit: 'Save',
      bulkedit: 'Save changes',
      delete: 'Delete',
      restore: 'Restore',
      unarchive: 'Unarchive',
      checkout: 'Check out',
      checkin: 'Check in',
      adjust: 'Adjust quantity',
      consume: 'Mark consumed',
      complete: 'Complete maintenance',
      note: 'Add note',
      'add-line': 'Add item',
      'edit-line': 'Save quantity',
      'remove-line': 'Remove item',
    }[action];
  }

  back() {
    if (this.fromDetail && this.current()) {
      this.operation.set(null);
      this.drawerTitle.set(String(this.current()?.['name']));
      this.error.set('');
    } else this.close();
  }

  close() {
    this.detailSequence++;
    this.drawer.set(false);
    this.current.set(null);
    this.currentId.set(null);
    this.operation.set(null);
  }

  async submit() {
    if (this.saving()) return;
    const action = this.operation();
    if (action === null) return;
    if (this.form().invalid) {
      this.error.set('Complete the required fields.');
      return;
    }
    this.saving.set(true);
    this.error.set('');
    const id = this.currentId();
    const base = `/${this.resource}`;
    const path = `${base}/${id}`;
    const values = Object.fromEntries(
      Object.entries(this.form().controls)
        .filter(([, control]) => action !== 'bulkedit' || control.dirty)
        .map(([key, control]) => [key, control.value === '' ? null : control.value]),
    );
    try {
      switch (action) {
        case 'edit':
          if (id === null && values['qty'] == null) delete values['qty'];
          await this.api.write(id === null ? 'POST' : 'PATCH', id === null ? base : path, values);
          break;
        case 'bulkedit':
          await this.api.write('POST', base + '/bulkedit', { ids: this.ids, changes: values });
          break;
        case 'delete':
          if (id === null) await this.api.write('POST', base + '/bulkdelete', { ids: this.ids });
          else await this.api.write('DELETE', path);
          break;
        case 'restore':
          if (id === null) await this.api.write('POST', base + '/bulkrestore', { ids: this.ids });
          else await this.api.write('POST', path + '/restore', {});
          break;
        case 'unarchive':
          await this.api.write('POST', path + '/unarchive', {});
          break;
        case 'checkout':
          await this.api.write(
            'POST',
            path + '/checkout',
            this.resource === 'kits'
              ? values
              : {
                  ...values,
                  target_type: this.target,
                  ...(this.entry
                    ? { seat_id: this.entry.id, reassign: this.entry['occupied'] === true }
                    : {}),
                },
          );
          break;
        case 'checkin':
          await this.api.write(
            'POST',
            this.resource === 'components'
              ? `${base}/${this.entry?.id}/checkin`
              : path + '/checkin',
            { ...values, assignment_id: this.entry?.id },
          );
          break;
        case 'adjust':
          await this.api.write(
            'POST',
            path + '/adjust-quantity',
            Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null)),
          );
          break;
        case 'consume':
          await this.api.write('POST', path + '/consume/' + this.entry?.id, {});
          break;
        case 'complete':
          await this.api.write('POST', path + '/complete', values);
          break;
        case 'note':
          await this.api.write('POST', path + '/notes', values);
          break;
        case 'add-line':
          await this.api.write('POST', path + '/' + this.kitKind, values);
          break;
        case 'edit-line':
          await this.api.write('PUT', path + '/' + this.kitKind + '/' + this.entry?.id, values);
          break;
        case 'remove-line':
          await this.api.write('DELETE', path + '/' + this.kitKind + '/' + this.entry?.id);
          break;
      }
      const tab = this.activeTab();
      if (this.fromDetail && id !== null) {
        await this.openDetail(id);
        this.showTab(tab);
      } else this.close();
      this.message.set('Change saved.');
      this.grid()?.clearSelection();
      await this.load();
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.saving.set(false);
    }
  }
}

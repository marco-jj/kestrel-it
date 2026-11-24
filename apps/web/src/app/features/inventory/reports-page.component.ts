import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  REPORT_TYPES,
  type PermissionKey,
  type ReportType,
  type StandardApiResponse,
} from '@kestrel-it/shared';
import { AuthStore } from '../../core/auth/auth.store.js';
import {
  KestrelDataGridComponent,
  type DataGridColumn,
  type DataGridRow,
} from '../../shared/ui/data-grid.component.js';
import { InventoryApi, inventoryError } from './inventory-api.js';
import { saveDownload } from './inventory-files.component.js';

export const reportNames: Record<ReportType, string> = {
  activity: 'Activity',
  custom: 'Custom Assets',
  'custom-components': 'Custom Components',
  'custom-consumables': 'Custom Consumables',
  depreciation: 'Depreciation',
  licenses: 'Licenses',
  maintenances: 'Maintenance',
  'unaccepted-assets': 'Unaccepted Assets',
  accessories: 'Accessories',
  audit: 'Audit',
};
type Template = {
  id: number;
  name: string;
  isShared: boolean;
  createdBy: number;
  options: Record<string, unknown>;
};
type FilterValue = string | number | boolean;

@Component({
  selector: 'kestrel-reports-page',
  imports: [FormsModule, RouterLink, KestrelDataGridComponent],
  template: `
    <header><h1>Reports</h1></header>
    @if (canReports) {
      <nav aria-label="Reports">
        @for (item of types; track item) {
          <a
            class="k-btn"
            [class.k-btn-primary]="type() === item"
            [class.k-btn-secondary]="type() !== item"
            [routerLink]="['/reports', item]"
            >{{ names[item] }}</a
          >
        }
      </nav>
    }
    <h2>{{ names[type()] }}</h2>
    <form class="filters" (ngSubmit)="page = 1; load()">
      <label>From <input type="date" name="from" [(ngModel)]="filters['from']" /></label>
      <label>To <input type="date" name="to" [(ngModel)]="filters['to']" /></label>
      @if (canReports && type() !== 'unaccepted-assets') {
        <label
          >Company ID
          <input type="number" min="1" name="company" [(ngModel)]="filters['company_id']"
        /></label>
      }
      @if (type() === 'activity') {
        <label
          >Item type
          <select name="item" [(ngModel)]="filters['item_type']">
            <option value="">All types</option>
            <option value="asset">Asset</option>
            <option value="license">License</option>
            <option value="accessory">Accessory</option>
            <option value="consumable">Consumable</option>
            <option value="component">Component</option>
            <option value="user">User</option>
          </select></label
        >
        <label
          >Action
          <select name="action" [(ngModel)]="filters['action_type']">
            <option value="">All actions</option>
            <option value="checkout">Checkout</option>
            <option value="checkin from">Check-in</option>
            <option value="audit">Audit</option>
            <option value="create">Create</option>
            <option value="update">Update</option>
            <option value="uploaded">Upload</option>
            <option value="delete">Delete</option>
          </select></label
        >
      }
      @if (type() === 'depreciation') {
        <label>Value as of <input type="date" name="asof" [(ngModel)]="filters['as_of']" /></label>
      }
      @if (custom()) {
        <label
          >Category ID
          <input type="number" min="1" name="category" [(ngModel)]="filters['category_id']"
        /></label>
        @if (type() === 'custom') {
          <label
            >Date field
            <select name="datefield" [(ngModel)]="filters['date_field']">
              <option value="purchase_date">Purchase</option>
              <option value="last_checkout">Last checkout</option>
              <option value="last_checkin">Last check-in</option>
              <option value="updated_at">Last updated</option>
            </select></label
          >
          <label
            >Assignment
            <select name="assigned" [(ngModel)]="filters['assigned']">
              <option value="">Any</option>
              <option value="yes">Assigned</option>
              <option value="no">Unassigned</option>
            </select></label
          >
          <label
            >Model ID <input type="number" min="1" name="model" [(ngModel)]="filters['model_id']"
          /></label>
          <label
            >Location ID
            <input type="number" min="1" name="location" [(ngModel)]="filters['location_id']"
          /></label>
        }
      }
      <button class="k-btn k-btn-primary" type="submit">Apply filters</button>
    </form>
    @if (custom()) {
      <details class="builder">
        <summary>Columns and report templates</summary>
        <div class="columns">
          @for (key of available(); track key) {
            <label
              ><input
                type="checkbox"
                [checked]="selection().length ? selection().includes(key) : isSelected(key)"
                (change)="toggle(key)"
              />
              {{ title(key) }}</label
            >
          }
        </div>
        <div class="filters">
          <label
            >Template
            <select [(ngModel)]="templateId" (ngModelChange)="selectTemplate($event)">
              <option [ngValue]="null">New template</option>
              @for (template of templates(); track template.id) {
                <option [ngValue]="template.id">{{ template.name }}</option>
              }
            </select></label
          >
          <label>Template name <input [(ngModel)]="templateName" maxlength="255" /></label>
          <label><input type="checkbox" [(ngModel)]="share" /> Share with report viewers</label>
          <button
            class="k-btn k-btn-primary"
            [disabled]="!templateName.trim() || !ownsTemplate()"
            (click)="saveTemplate()"
          >
            Save template
          </button>
          @if (templateId && ownsTemplate()) {
            <button class="k-btn k-btn-secondary" (click)="deleteTemplate()">
              Delete template
            </button>
          }
        </div>
      </details>
    }
    <div class="actions">
      <button class="k-btn k-btn-secondary" (click)="download('csv')">Export CSV</button>
      <button class="k-btn k-btn-secondary" (click)="download('xlsx')">Export Excel</button>
      @if (type() === 'unaccepted-assets' && canRemind()) {
        <button class="k-btn k-btn-secondary" [disabled]="!selected().length" (click)="remind()">
          Send reminders
        </button>
      }
      @if (type() === 'activity') {
        <button class="k-btn k-btn-secondary" (click)="chart()">Activity by date</button>
      }
    </div>
    @if (chartRows().length) {
      <ul aria-label="Activity by date">
        @for (row of chartRows(); track row.date) {
          <li>
            {{ row.date }} <meter [max]="chartMax()" [value]="row.count"></meter> {{ row.count }}
          </li>
        }
      </ul>
    }
    @if (error()) {
      <p role="alert">{{ error() }}</p>
    }
    @if (message()) {
      <p role="status">{{ message() }}</p>
    }
    @if (type() === 'unaccepted-assets' && canRemind()) {
      <div class="columns" aria-label="Select pending acceptances">
        @for (row of rows(); track row.id) {
          <label
            ><input
              type="checkbox"
              [checked]="selected().includes(+row.id!)"
              (change)="toggleAcceptance(+row.id!)"
            />
            {{ row['asset_tag'] || row['name'] || row.id }}</label
          >
        }
      </div>
    }
    <kestrel-data-grid
      [rows]="rows()"
      [columns]="columns()"
      [total]="total()"
      [page]="page"
      [creatable]="false"
      [selectable]="false"
      [loading]="busy()"
      emptyTitle="No matching records"
      (pageChanged)="page = $event; load()"
      (searchChanged)="search = $event; page = 1; load()"
      (sortChanged)="sort = $event.sort; order = $event.order; load()"
    />
  `,
  styles: [
    `
      :host {
        display: block;
      }
      h1 {
        font-size: 1.6rem;
        font-weight: 650;
      }
      h2 {
        font-size: 1.2rem;
        font-weight: 600;
        margin-block: 1rem;
      }
      nav,
      .filters,
      .actions,
      .columns {
        display: flex;
        align-items: end;
        gap: 0.65rem;
        flex-wrap: wrap;
        margin-block: 0.75rem;
      }
      label {
        display: grid;
        gap: 0.25rem;
      }
      .columns label {
        display: flex;
        align-items: center;
        gap: 0.35rem;
      }
      .builder {
        border: 1px solid var(--kestrel-border);
        padding: 1rem;
        border-radius: 0.5rem;
      }
      [role='alert'] {
        color: var(--kestrel-danger);
      }
    `,
  ],
})
export class ReportsPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(InventoryApi);
  private readonly auth = inject(AuthStore);
  readonly types = REPORT_TYPES;
  readonly names = reportNames;
  readonly type = signal<ReportType>('activity');
  readonly rows = signal<DataGridRow[]>([]);
  readonly columns = signal<DataGridColumn[]>([]);
  readonly available = signal<string[]>([]);
  readonly selection = signal<string[]>([]);
  readonly selected = signal<number[]>([]);
  readonly chartRows = signal<{ date: string; count: number }[]>([]);
  readonly templates = signal<Template[]>([]);
  readonly error = signal('');
  readonly message = signal('');
  readonly busy = signal(false);
  readonly total = signal(0);
  filters: Record<string, FilterValue> = {};
  templateName = '';
  templateId: number | null = null;
  share = false;
  page = 1;
  search = '';
  sort = '';
  order = 'desc';
  private revision = 0;

  get canReports() {
    return (
      this.auth.isSuperUser() || this.auth.currentUser()?.keyPermissions?.['reports.view'] === true
    );
  }

  ngOnInit() {
    this.route.paramMap.subscribe((params) => {
      const requested = params.get('type') as ReportType | null;
      this.type.set(
        requested && this.types.includes(requested)
          ? requested
          : this.route.snapshot.routeConfig?.path === 'unaccepted-acceptances'
            ? 'unaccepted-assets'
            : 'activity',
      );
      this.filters = {};
      this.selection.set([]);
      this.selected.set([]);
      this.chartRows.set([]);
      this.templateId = null;
      this.templateName = '';
      this.share = false;
      this.page = 1;
      this.search = '';
      this.sort = '';
      if (this.custom()) void this.loadTemplates();
      void this.load();
    });
  }

  custom() {
    return this.type().startsWith('custom');
  }
  title(key: string) {
    return key
      .replace(/^_snipeit_/, '')
      .replaceAll('_', ' ')
      .replace(/^./, (letter) => letter.toUpperCase());
  }
  chartMax() {
    return Math.max(1, ...this.chartRows().map((row) => row.count));
  }
  canRemind() {
    const keys: PermissionKey[] = [
      'assets.checkout',
      'accessories.checkout',
      'licenses.checkout',
      'consumables.checkout',
    ];
    return (
      this.auth.isSuperUser() || keys.some((key) => this.auth.currentUser()?.keyPermissions?.[key])
    );
  }

  private query() {
    return {
      ...Object.fromEntries(
        Object.entries(this.filters).filter(([, value]) => value != null && value !== ''),
      ),
      ...(this.selection().length ? { columns: this.selection().join(',') } : {}),
      ...(this.search ? { search: this.search } : {}),
      ...(this.sort ? { sort: this.sort, order: this.order } : {}),
      ...((!this.canReports || this.route.snapshot.queryParamMap.get('scoped') === 'true') &&
      this.type() === 'activity'
        ? { scoped: 'true' }
        : {}),
    };
  }

  async load() {
    const revision = ++this.revision;
    this.error.set('');
    this.busy.set(true);
    try {
      const result = await this.api.read<{
        rows: DataGridRow[];
        total: number;
        columns: string[];
        available_columns: string[];
      }>(`/reports/${this.type()}`, { ...this.query(), page: this.page });
      if (revision !== this.revision) return;
      this.rows.set(result.rows);
      this.total.set(result.total);
      this.columns.set(result.columns.map((key) => ({ key, label: this.title(key) })));
      this.available.set(result.available_columns);
    } catch (error) {
      if (revision === this.revision) this.error.set(inventoryError(error));
    } finally {
      if (revision === this.revision) this.busy.set(false);
    }
  }

  isSelected(key: string) {
    return this.selection().length
      ? this.selection().includes(key)
      : this.columns().some((column) => column.key === key);
  }

  toggle(key: string) {
    if (!this.selection().length) this.selection.set(this.columns().map((column) => column.key));
    this.selection.update((current) =>
      current.includes(key)
        ? current.length > 1
          ? current.filter((item) => item !== key)
          : current
        : [...current, key],
    );
    this.page = 1;
    void this.load();
  }

  toggleAcceptance(id: number) {
    this.selected.update((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  async remind() {
    try {
      const { payload } = await this.api.write<{ queued: number }>(
        'POST',
        '/unaccepted-acceptances/send-reminders',
        { ids: this.selected() },
      );
      this.message.set(`${payload?.queued ?? 0} reminder(s) queued.`);
      this.selected.set([]);
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  async chart() {
    try {
      const result = await this.api.read<StandardApiResponse<{ date: string; count: number }[]>>(
        '/reports/activity/chart',
        this.query(),
      );
      this.chartRows.set(result.payload ?? []);
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  async download(format: 'csv' | 'xlsx') {
    try {
      saveDownload(
        await this.api.blob(`/reports/${this.type()}`, { ...this.query(), format }),
        `${this.type()}.${format}`,
      );
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  private async loadTemplates() {
    const report = this.type();
    try {
      const result = await this.api.read<StandardApiResponse<Template[]>>('/report-templates');
      if (report === this.type())
        this.templates.set(
          (result.payload ?? []).filter((row) => row.options['report'] === report),
        );
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  selectTemplate(id: number | null) {
    const row = this.templates().find((entry) => entry.id === id);
    this.templateName = row?.name ?? '';
    this.share = row?.isShared ?? false;
    if (!row) return;
    const { columns, report, search, ...filters } = row.options;
    this.filters = filters as Record<string, FilterValue>;
    this.search = typeof search === 'string' ? search : '';
    this.selection.set(typeof columns === 'string' ? columns.split(',') : []);
    this.page = 1;
    void this.load();
  }

  ownsTemplate() {
    return (
      !this.templateId ||
      this.templates().find((row) => row.id === this.templateId)?.createdBy ===
        this.auth.currentUser()?.id
    );
  }

  async saveTemplate() {
    try {
      const result = await this.api.write<Template>(
        this.templateId ? 'PATCH' : 'POST',
        this.templateId ? `/report-templates/${this.templateId}` : '/report-templates',
        {
          name: this.templateName,
          report: this.type(),
          is_shared: this.share,
          options: this.query(),
        },
      );
      this.templateId = result.payload?.id ?? null;
      this.message.set('Report template saved');
      await this.loadTemplates();
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  async deleteTemplate() {
    try {
      await this.api.write('DELETE', `/report-templates/${this.templateId}`);
      this.templateId = null;
      this.selectTemplate(null);
      await this.loadTemplates();
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }
}

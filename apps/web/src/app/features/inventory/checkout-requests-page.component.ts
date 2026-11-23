import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { SelectlistResponse } from '@kestrel-it/shared';
import {
  KestrelAsyncSelectComponent,
  type AsyncSelectOption,
} from '../../shared/ui/async-select.component.js';
import {
  KestrelDataGridComponent,
  type DataGridActionType,
  type DataGridRow,
} from '../../shared/ui/data-grid.component.js';
import { KestrelSlideDrawerComponent } from '../../shared/ui/slide-drawer.component.js';
import { InventoryApi, inventoryError } from './inventory-api.js';

type Catalog = 'hardware' | 'models';
type Operation = 'request' | 'cancel' | 'checkout';

@Component({
  selector: 'kestrel-checkout-requests-page',
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    KestrelDataGridComponent,
    KestrelAsyncSelectComponent,
    KestrelSlideDrawerComponent,
  ],
  template: `
    <header>
      <h1>
        {{ staff ? 'Checkout requests' : personal ? 'My requests' : 'Requestable inventory' }}
      </h1>
      @if (!staff) {
        <nav>
          <a routerLink="/account/requestable">Catalog</a>
          <a routerLink="/account/requests">My requests</a>
        </nav>
      }
    </header>
    @if (!staff && !personal) {
      <div class="tabs" aria-label="Inventory type">
        <button
          type="button"
          class="k-btn"
          [class.k-btn-primary]="catalog() === 'hardware'"
          [class.k-btn-secondary]="catalog() !== 'hardware'"
          (click)="choose('hardware')"
        >
          Hardware
        </button>
        <button
          type="button"
          class="k-btn"
          [class.k-btn-primary]="catalog() === 'models'"
          [class.k-btn-secondary]="catalog() !== 'models'"
          (click)="choose('models')"
        >
          Models
        </button>
      </div>
    }
    @if (error() && !drawer()) {
      <p role="alert">{{ error() }}</p>
    }
    @if (message()) {
      <p role="status">{{ message() }}</p>
    }
    <kestrel-data-grid
      [columns]="columns()"
      [rows]="rows()"
      [total]="total()"
      [page]="page()"
      [loading]="loading()"
      [creatable]="false"
      [selectable]="false"
      (pageChanged)="page.set($event); load()"
      (searchChanged)="search = $event; page.set(1); load()"
      (rowAction)="act($event)"
    />
    <kestrel-slide-drawer [open]="drawer()" [title]="title()" (closed)="drawer.set(false)">
      @if (drawer()) {
        <p>{{ label() }}</p>
        @if (operation() === 'request') {
          <label>Start date <input type="date" [(ngModel)]="start" /></label>
          <label>End date <input type="date" [(ngModel)]="end" /></label>
          <label>Notes <textarea rows="3" [(ngModel)]="notes"></textarea></label>
        }
        @if (operation() === 'checkout') {
          @if (row()?.['requestable_type'] === 'model') {
            <kestrel-async-select
              label="Select an available asset"
              [options]="availableAssets()"
              [allowQuickCreate]="false"
              (selectionChanged)="selectAsset($event)"
              (searchChanged)="loadAssets($event)"
            />
          }
          <label>Expected return date <input type="date" [(ngModel)]="end" /></label>
          <label>Checkout note <textarea rows="3" [(ngModel)]="notes"></textarea></label>
        }
        @if (error()) {
          <p role="alert">{{ error() }}</p>
        }
        <div class="actions">
          <button type="button" class="k-btn k-btn-secondary" (click)="drawer.set(false)">
            Back
          </button>
          <button
            type="button"
            class="k-btn k-btn-primary"
            [disabled]="saving()"
            (click)="submit()"
          >
            {{ title() }}
          </button>
        </div>
      }
    </kestrel-slide-drawer>
  `,
  styles: [
    `
      header,
      .actions,
      .tabs,
      nav {
        display: flex;
        align-items: center;
        gap: 0.65rem;
        flex-wrap: wrap;
      }
      header {
        justify-content: space-between;
        margin-bottom: 1rem;
      }
      .tabs {
        margin-bottom: 0.75rem;
      }
      nav a {
        text-decoration: underline;
      }
      h1 {
        font-size: 1.6rem;
        font-weight: 640;
      }
      label {
        display: grid;
        gap: 0.4rem;
        margin-block: 0.9rem;
      }
      input,
      textarea {
        padding: 0.45rem;
        border: 1px solid var(--kestrel-border);
        border-radius: 0.4rem;
      }
      .actions {
        margin-top: 1rem;
        justify-content: flex-end;
      }
      [role='alert'] {
        color: var(--kestrel-danger);
      }
    `,
  ],
})
export class CheckoutRequestsPageComponent implements OnInit {
  private readonly api = inject(InventoryApi);
  private readonly route = inject(ActivatedRoute);
  readonly staff = this.route.snapshot.routeConfig?.path === 'requests';
  readonly personal = this.route.snapshot.routeConfig?.path === 'account/requests';
  readonly catalog = signal<Catalog>('hardware');
  readonly rows = signal<DataGridRow[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly loading = signal(false);
  readonly drawer = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly message = signal('');
  readonly row = signal<DataGridRow | null>(null);
  readonly operation = signal<Operation>('request');
  readonly availableAssets = signal<AsyncSelectOption[]>([]);
  search = '';
  start = '';
  end = '';
  notes = '';
  private asset: number | null = null;
  private request = 0;
  private assetRequest = 0;

  ngOnInit(): void {
    void this.load();
  }

  columns() {
    const cols =
      this.staff || this.personal
        ? [
            { key: 'item', label: 'Item' },
            { key: 'state', label: 'State' },
            { key: 'requested_at', label: 'Requested at' },
            ...(this.staff ? [{ key: 'requester', label: 'Requester' }] : []),
          ]
        : [
            {
              key: this.catalog() === 'hardware' ? 'asset_tag' : 'model_number',
              label: this.catalog() === 'hardware' ? 'Tag' : 'Model number',
            },
            { key: 'name', label: 'Name' },
          ];
    return cols.map((column) => ({ ...column, sortable: false }));
  }

  title() {
    if (this.operation() === 'request') return 'Submit request';
    if (this.operation() === 'cancel') return 'Cancel request';
    return 'Fulfill request';
  }

  label() {
    const row = this.row();
    return row?.['item'] ?? row?.['asset_tag'] ?? row?.['name'] ?? 'Selected item';
  }

  choose(kind: Catalog) {
    this.catalog.set(kind);
    this.page.set(1);
    void this.load();
  }

  async load() {
    const request = ++this.request;
    this.loading.set(true);
    try {
      const path = this.staff
        ? '/requests'
        : this.personal
          ? '/account/requests'
          : `/account/requestable/${this.catalog()}`;
      const data = await this.api.records(path, {
        page: this.page(),
        limit: 20,
        search: this.search,
      });
      if (request !== this.request) return;
      this.rows.set(data.rows);
      this.total.set(data.total);
    } catch (error) {
      if (request === this.request) this.error.set(inventoryError(error));
    } finally {
      if (request === this.request) this.loading.set(false);
    }
  }

  act(event: { action: DataGridActionType; row: DataGridRow }) {
    const action = event.action;
    if (action !== 'request' && action !== 'cancel' && action !== 'checkout') return;
    this.operation.set(action);
    this.row.set(event.row);
    this.asset = null;
    this.start = '';
    this.end = '';
    this.notes = '';
    this.error.set('');
    this.message.set('');
    this.drawer.set(true);
    if (action === 'checkout' && event.row['requestable_type'] === 'model')
      void this.loadAssets('');
  }

  selectAsset(option: AsyncSelectOption | null) {
    this.asset = typeof option?.id === 'number' ? option.id : null;
  }

  async loadAssets(search: string) {
    const modelId = this.row()?.['requestable_id'];
    if (typeof modelId !== 'number') return;
    const request = ++this.assetRequest;
    try {
      const data = await this.api.read<SelectlistResponse>('/hardware/targets/asset', {
        statusType: 'deployable',
        model_id: modelId,
        search,
      });
      if (request === this.assetRequest)
        this.availableAssets.set(data.results.map(({ id, text }) => ({ id, text })));
    } catch (error) {
      if (request === this.assetRequest) this.error.set(inventoryError(error));
    }
  }

  async submit() {
    const row = this.row();
    const operation = this.operation();
    if (this.saving() || typeof row?.id !== 'number') return;
    if (operation === 'checkout' && row['requestable_type'] === 'model' && this.asset === null) {
      this.error.set('Select an available asset of this model.');
      return;
    }
    this.saving.set(true);
    this.error.set('');
    try {
      const catalog = this.catalog() === 'models' ? '/models' : '';
      const self = `/account/request${catalog}/${row.id}`;
      if (operation === 'request') {
        await this.api.write('POST', self, {
          start_date: this.start || null,
          end_date: this.end || null,
          notes: this.notes || null,
        });
      } else if (operation === 'cancel') {
        const path = this.staff
          ? `/requests/${row.id}`
          : this.personal
            ? `/account/requests/${row.id}`
            : self;
        await this.api.write('POST', `${path}/cancel`, {});
      } else {
        await this.api.write('POST', `/requests/${row.id}/fulfill`, {
          ...(this.asset === null ? {} : { asset_id: this.asset }),
          expected_checkin: this.end || null,
          ...(this.notes ? { note: this.notes } : {}),
        });
      }
      this.message.set(
        operation === 'request'
          ? 'Request submitted.'
          : operation === 'cancel'
            ? 'Request canceled.'
            : 'Request fulfilled.',
      );
      this.drawer.set(false);
      await this.load();
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.saving.set(false);
    }
  }
}

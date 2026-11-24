import { Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthStore } from '../../core/auth/auth.store.js';
import { KestrelDataGridComponent, type DataGridRow } from '../../shared/ui/data-grid.component.js';
import { InventoryApi, inventoryError } from '../inventory/inventory-api.js';

@Component({
  selector: 'kestrel-low-stock',
  standalone: true,
  imports: [KestrelDataGridComponent],
  template: `
    @if (visible) {
      <section aria-labelledby="low-stock-title">
        <h2 id="low-stock-title">Low stock</h2>
        @if (error()) {
          <p role="alert">{{ error() }}</p>
        }
        <kestrel-data-grid
          [rows]="rows()"
          [columns]="columns"
          [page]="page()"
          [total]="total()"
          [loading]="loading()"
          [selectable]="false"
          [creatable]="false"
          emptyTitle="No low-stock items"
          emptyDescription="Available stock is above the configured thresholds."
          (pageChanged)="page.set($event); load()"
          (searchChanged)="search = $event; page.set(1); load()"
          (sortChanged)="sort = $event.sort; order = $event.order; load()"
          (rowAction)="open($event.row)"
        />
      </section>
    }
  `,
  styles: [
    `
      section {
        margin-block: 1.1rem;
      }
      h2 {
        font-size: 1.15rem;
        font-weight: 600;
        margin-bottom: 0.75rem;
      }
      [role='alert'] {
        color: var(--kestrel-danger);
      }
    `,
  ],
})
export class LowStockComponent implements OnInit {
  private readonly api = inject(InventoryApi);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthStore);
  readonly rows = signal<DataGridRow[]>([]);
  readonly error = signal('');
  readonly loading = signal(false);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly columns = [
    { key: 'name', label: 'Item' },
    { key: 'type', label: 'Type' },
    { key: 'qty', label: 'Total' },
    { key: 'remaining', label: 'Remaining' },
    { key: 'min_amt', label: 'Minimum' },
  ];
  sort = 'remaining';
  order = 'asc';
  search = '';
  private revision = 0;

  get visible() {
    return (
      this.auth.isAdmin() ||
      this.auth.isSuperUser() ||
      this.auth.can('accessories.view') ||
      this.auth.can('consumables.view') ||
      this.auth.can('components.view') ||
      this.auth.can('licenses.view') ||
      (this.auth.can('models.view') && this.auth.can('assets.view'))
    );
  }

  ngOnInit(): void {
    if (this.visible) void this.load();
  }

  async load() {
    const seq = ++this.revision;
    this.loading.set(true);
    this.error.set('');
    try {
      const response = await this.api.records('/low-stock', {
        page: this.page(),
        limit: 20,
        search: this.search,
        sort: this.sort,
        order: this.order,
      });
      if (seq !== this.revision) return;
      this.total.set(response.total);
      this.rows.set(
        response.rows.map((row) => ({
          ...row,
          id: `${row['type']}:${row.id}`,
          available_actions: { view: true },
        })),
      );
    } catch (error) {
      if (seq === this.revision) this.error.set(inventoryError(error));
    } finally {
      if (seq === this.revision) this.loading.set(false);
    }
  }

  open(row: DataGridRow) {
    if (typeof row['url'] === 'string') void this.router.navigateByUrl(row['url']);
  }
}

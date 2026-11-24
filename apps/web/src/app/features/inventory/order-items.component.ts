import { Component, Input, OnChanges, inject, signal } from '@angular/core';
import {
  KestrelDataGridComponent,
  type DataGridColumn,
  type DataGridRow,
} from '../../shared/ui/data-grid.component.js';
import { InventoryApi, inventoryError } from './inventory-api.js';

@Component({
  selector: 'kestrel-order-items',
  standalone: true,
  imports: [KestrelDataGridComponent],
  template: `
    @if (error()) {
      <p role="alert">{{ error() }}</p>
    }
    <kestrel-data-grid
      [rows]="rows()"
      [columns]="columns"
      [total]="total()"
      [page]="page()"
      [loading]="loading()"
      [selectable]="false"
      [creatable]="false"
      emptyTitle="No acquisitions"
      emptyDescription="Purchase lines appear here after replenishment."
      (searchChanged)="search = $event; page.set(1); load()"
      (pageChanged)="page.set($event); load()"
      (sortChanged)="sort = $event.sort; order = $event.order; load()"
    />
  `,
})
export class OrderItemsComponent implements OnChanges {
  @Input({ required: true }) itemId!: number;
  @Input({ required: true }) itemType!: string;
  private readonly api = inject(InventoryApi);
  readonly rows = signal<DataGridRow[]>([]);
  readonly error = signal('');
  readonly loading = signal(false);
  readonly total = signal(0);
  readonly page = signal(1);
  search = '';
  sort = '';
  order = 'desc';
  private revision = 0;
  readonly columns: DataGridColumn[] = [
    { key: 'order_number', label: 'Order number' },
    { key: 'supplier', label: 'Supplier' },
    { key: 'quantity', label: 'Quantity' },
    { key: 'unit_cost', label: 'Unit cost' },
    { key: 'currency', label: 'Currency', sortable: false },
    { key: 'purchase_date', label: 'Purchased' },
  ];

  ngOnChanges(): void {
    this.page.set(1);
    void this.load();
  }

  async load() {
    const revision = ++this.revision;
    this.loading.set(true);
    this.error.set('');
    try {
      const data = await this.api.records('/order-items', {
        ...(this.itemType === 'model'
          ? { asset_model_id: this.itemId }
          : { item_id: this.itemId, item_type: this.itemType }),
        page: this.page(),
        limit: 20,
        search: this.search,
        sort: this.sort,
        order: this.order,
      });
      if (revision !== this.revision) return;
      this.rows.set(data.rows);
      this.total.set(data.total);
    } catch (error) {
      if (revision === this.revision) this.error.set(inventoryError(error));
    } finally {
      if (revision === this.revision) this.loading.set(false);
    }
  }
}

import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthStore } from '../../core/auth/auth.store.js';
import { KestrelDataGridComponent, type DataGridRow } from '../../shared/ui/data-grid.component.js';
import { InventoryApi, inventoryError } from '../inventory/inventory-api.js';

@Component({
  selector: 'kestrel-recent-activity',
  imports: [KestrelDataGridComponent, RouterLink],
  template: `
    @if (visible()) {
      <section aria-label="Recent activity">
        <header>
          <h2>Recent activity</h2>
          <a
            class="k-btn k-btn-secondary"
            routerLink="/reports/activity"
            [queryParams]="{ scoped: 'true' }"
            >View all activity</a
          >
        </header>
        @if (error()) {
          <p role="alert">{{ error() }}</p>
        }
        <kestrel-data-grid
          [rows]="rows()"
          [columns]="columns"
          [creatable]="false"
          [selectable]="false"
          [searchable]="false"
          [total]="rows().length"
          emptyTitle="No recent activity"
        />
      </section>
    }
  `,
  styles: [
    `
      header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 0.75rem;
        margin-bottom: 0.65rem;
      }
      h2 {
        font-weight: 650;
      }
    `,
  ],
})
export class RecentActivityComponent implements OnInit {
  private readonly api = inject(InventoryApi);
  private readonly auth = inject(AuthStore);
  readonly rows = signal<DataGridRow[]>([]);
  readonly error = signal('');
  readonly columns = [
    { key: 'action_date', label: 'Date', sortable: false },
    { key: 'action_type', label: 'Action', sortable: false },
    { key: 'item_type', label: 'Resource', sortable: false },
    { key: 'item_id', label: 'Record', sortable: false },
  ];

  visible() {
    return (
      this.auth.can('assets.view') ||
      this.auth.can('users.view') ||
      this.auth.can('licenses.view') ||
      this.auth.can('accessories.view') ||
      this.auth.can('consumables.view') ||
      this.auth.can('components.view')
    );
  }

  async ngOnInit() {
    if (!this.visible()) return;
    try {
      this.rows.set((await this.api.records('/dashboard/activity', { limit: 8 })).rows);
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }
}

import { Component, OnInit, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AuthStore } from '../../core/auth/auth.store.js';
import { KestrelDataGridComponent, type DataGridRow } from '../../shared/ui/data-grid.component.js';
import { KestrelSlideDrawerComponent } from '../../shared/ui/slide-drawer.component.js';
import { AssetAuditFormComponent } from './asset-audit-form.component.js';
import { InventoryApi, inventoryError } from './inventory-api.js';

@Component({
  selector: 'kestrel-audit-list',
  standalone: true,
  imports: [
    RouterLink,
    KestrelDataGridComponent,
    KestrelSlideDrawerComponent,
    AssetAuditFormComponent,
  ],
  template: `
    <header>
      <h1>{{ titles[status] }}</h1>
      <a class="k-btn k-btn-secondary" routerLink="/hardware">All assets</a>
      @if (status !== 'due') {
        <a class="k-btn k-btn-secondary" routerLink="/hardware/audit/due">Audits due</a>
      }
      @if (status !== 'overdue') {
        <a class="k-btn k-btn-secondary" routerLink="/hardware/audit/overdue">Overdue audits</a>
      }
    </header>
    @if (error()) {
      <p role="alert">{{ error() }}</p>
    }
    <kestrel-data-grid
      [rows]="rows()"
      [columns]="columns"
      [total]="total()"
      [page]="page()"
      [selectable]="canAudit"
      [creatable]="false"
      [bulkAudit]="canAudit"
      [bulkEdit]="false"
      [bulkDelete]="false"
      (searchChanged)="search = $event; page.set(1); load()"
      (pageChanged)="page.set($event); load()"
      (rowAction)="open($event.row)"
      (bulkAction)="bulk($event.selectedIds)"
    />
    <kestrel-slide-drawer [open]="active() !== null" title="Audit assets" (closed)="close()">
      @if (active(); as job) {
        <kestrel-asset-audit-form
          [asset]="job.asset"
          [ids]="job.ids"
          (closed)="close()"
          (saved)="close()"
        />
      }
    </kestrel-slide-drawer>
  `,
  styles: [
    `
      header {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.65rem;
        margin-bottom: 1rem;
      }
      h1 {
        font-size: 1.6rem;
        font-weight: 640;
        margin-right: auto;
      }
      [role='alert'] {
        color: var(--kestrel-danger);
      }
    `,
  ],
})
export class AuditListComponent implements OnInit {
  private readonly api = inject(InventoryApi);
  private readonly auth = inject(AuthStore);
  private readonly route = inject(ActivatedRoute);
  private readonly grid = viewChild(KestrelDataGridComponent);
  readonly titles = {
    due: 'Audits due',
    overdue: 'Overdue audits',
    'due-or-overdue': 'Due and overdue audits',
  };
  readonly status = this.route.snapshot.data['status'] as keyof typeof this.titles;
  readonly rows = signal<DataGridRow[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly error = signal('');
  readonly active = signal<{ asset?: DataGridRow; ids: number[] } | null>(null);
  readonly columns = [
    { key: 'asset_tag', label: 'Asset tag', sortable: false },
    { key: 'name', label: 'Name', sortable: false },
    { key: 'next_audit_date', label: 'Next audit', sortable: false },
  ];
  search = '';
  private revision = 0;

  get canAudit() {
    return (
      this.auth.isSuperUser() || this.auth.currentUser()?.keyPermissions?.['assets.audit'] === true
    );
  }

  ngOnInit(): void {
    void this.load();
  }

  async load() {
    const seq = ++this.revision;
    this.error.set('');
    try {
      const response = await this.api.records('/hardware/audit/' + this.status, {
        page: this.page(),
        limit: 20,
        search: this.search,
      });
      if (seq !== this.revision) return;
      this.rows.set(
        response.rows.map((row) => ({ ...row, available_actions: { audit: this.canAudit } })),
      );
      this.total.set(response.total);
    } catch (error) {
      if (seq === this.revision) this.error.set(inventoryError(error));
    }
  }

  async open(row: DataGridRow) {
    try {
      const asset = await this.api.read<DataGridRow>(`/hardware/${row.id}/audit`);
      this.active.set({ asset, ids: [] });
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  bulk(ids: Array<number | string>) {
    this.active.set({ ids: ids.map(Number) });
  }

  close() {
    this.active.set(null);
    this.grid()?.clearSelection();
    void this.load();
  }
}

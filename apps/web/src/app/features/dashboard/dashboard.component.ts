import { RecentActivityComponent } from './recent-activity.component.js';
import { CommonModule } from '@angular/common';
import { Component, Inject, OnInit, Optional, computed, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { StandardApiResponse } from '@kestrel-it/shared';
import { LowStockComponent } from './low-stock.component.js';
import { AuthStore } from '../../core/auth/auth.store.js';
import { InventoryApi } from '../inventory/inventory-api.js';
import {
  KestrelDataGridComponent,
  KestrelStatusBadgeComponent,
  type DataGridColumn,
  type DataGridRow,
} from '../../shared/ui/index.js';

interface DashboardSummaryPayload {
  assets_total: number;
  status_breakdown: Record<string, number>;
  licenses_total: number;
  accessories_total: number;
  consumables_total: number;
  components_total: number;
  my_pending_acceptances: number;
  my_pending_requests: number;
  pending_checkout_requests: number;
  overdue_audits: number;
  active_maintenances: number;
}

interface DashboardCategoryRow {
  id: number;
  name: string;
  count: number;
}

@Component({
  selector: 'kestrel-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    LowStockComponent,
    RecentActivityComponent,
    KestrelDataGridComponent,
    KestrelStatusBadgeComponent,
  ],
  template: `
    <section class="dashboard">
      <div class="header-row">
        <div>
          <h1>IT Asset Operations Cockpit</h1>
          <p class="subtitle">
            Live RBAC- and FMCS-scoped telemetry across hardware, licenses, requests, and compliance.
          </p>
        </div>
        <div class="header-actions">
          <span class="role-chip k-mono">
            {{ authStore.isSuperUser() ? 'SUPERUSER' : authStore.isAdmin() ? 'ADMIN' : 'USER' }}
          </span>
          <a class="k-btn k-btn-secondary" routerLink="/account/requestable">Request Equipment</a>
          @if (authStore.can('assets.create') || authStore.isAdmin()) {
            <a class="k-btn k-btn-primary" routerLink="/hardware/create">New Asset</a>
          }
        </div>
      </div>

      <div class="kpi-grid">
        <article class="k-card kpi-card">
          <span class="kpi-label k-mono">HARDWARE ASSETS</span>
          <strong class="kpi-value k-mono">{{ summary()?.assets_total ?? 0 }}</strong>
          <div class="kpi-foot">
            <kestrel-status-badge statusMeta="deployable" [label]="statusSummaryLine()" />
          </div>
        </article>
        <article class="k-card kpi-card">
          <span class="kpi-label k-mono">LICENSES &amp; STOCK</span>
          <strong class="kpi-value k-mono">{{ secondaryTotal() }}</strong>
          <p class="kpi-note">
            {{ summary()?.licenses_total ?? 0 }} licenses ·
            {{ summary()?.accessories_total ?? 0 }} accessories ·
            {{ summary()?.consumables_total ?? 0 }} consumables ·
            {{ summary()?.components_total ?? 0 }} components
          </p>
        </article>
        <article class="k-card kpi-card">
          <span class="kpi-label k-mono">OPERATIONS QUEUE</span>
          <strong class="kpi-value k-mono">{{ operationsAttentionCount() }}</strong>
          <p class="kpi-note">
            <a routerLink="/requests">{{ summary()?.pending_checkout_requests ?? 0 }} pending requests</a> ·
            <a routerLink="/hardware/audit/overdue">{{ summary()?.overdue_audits ?? 0 }} overdue audits</a> ·
            <a routerLink="/maintenances">{{ summary()?.active_maintenances ?? 0 }} maintenances</a>
          </p>
        </article>
        <article class="k-card kpi-card">
          <span class="kpi-label k-mono">MY SELF-SERVICE &amp; FMCS</span>
          <strong class="kpi-value k-mono">{{ activeCompanyCount() }}</strong>
          <p class="kpi-note">
            {{ companyScopeSummary() }} ·
            <a routerLink="/account/accept">{{ summary()?.my_pending_acceptances ?? 0 }} acceptances</a> ·
            <a routerLink="/account/requests">{{ summary()?.my_pending_requests ?? 0 }} requests</a>
          </p>
        </article>
      </div>

      @if (categories().length) {
        <div class="k-card kpi-card">
          <div class="section-header">
            <h2>Assets by Category</h2>
            <span class="k-mono section-meta">FMCS live distribution</span>
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 0.6rem; margin-top: 0.5rem;">
            @for (cat of categories(); track cat.id) {
              <span class="role-chip k-mono">{{ cat.name }}: {{ cat.count }}</span>
            }
          </div>
        </div>
      }

      <kestrel-low-stock />
      <kestrel-recent-activity />

      @if (authStore.can('assets.view') || authStore.isAdmin()) {
        <div class="grid-section">
          <div class="section-header">
            <h2>Recent Hardware Inventory</h2>
            <span class="k-mono section-meta">Live API feed · {{ recentAssetsTotal() }} total in scope</span>
          </div>

          <kestrel-data-grid
            [serverSide]="false"
            [columns]="assetColumns"
            [rows]="recentAssets()"
            [total]="recentAssetsTotal()"
            [loading]="loading()"
            [creatable]="false"
            (rowAction)="onAssetRowAction($event)"
          />
        </div>
      }
    </section>
  `,
  styles: [
    `
      .dashboard {
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
      }
      .header-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
      }
      h1 {
        margin: 0;
        font-size: 1.4rem;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .subtitle {
        margin: 0.25rem 0 0;
        color: var(--kestrel-muted);
        font-size: 0.875rem;
      }
      .header-actions {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }
      .role-chip {
        background: var(--kestrel-accent-subtle);
        color: var(--kestrel-accent);
        border: 1px solid rgba(13, 148, 136, 0.28);
        padding: 0.25rem 0.65rem;
        border-radius: 999px;
        font-size: 0.72rem;
        font-weight: 700;
      }
      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 0.9rem;
      }
      .kpi-card {
        display: flex;
        flex-direction: column;
        gap: 0.45rem;
      }
      .kpi-label {
        font-size: 0.7rem;
        letter-spacing: 0.06em;
        color: var(--kestrel-muted);
      }
      .kpi-value {
        font-size: 1.35rem;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .kpi-note {
        color: var(--kestrel-muted);
        font-size: 0.8rem;
        margin: 0;
      }
      .grid-section {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .section-header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 1rem;
      }
      .section-header h2 {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
      }
      .section-meta {
        font-size: 0.75rem;
        color: var(--kestrel-muted);
      }
      .drawer-form {
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .info-note {
        padding: 0.65rem 0.75rem;
        border-radius: var(--kestrel-radius-md);
        background: var(--kestrel-accent-subtle);
        color: var(--kestrel-accent);
        font-size: 0.78rem;
      }
    `,
  ],
})
export class DashboardComponent implements OnInit {
  readonly summary = signal<DashboardSummaryPayload | null>(null);
  readonly categories = signal<DashboardCategoryRow[]>([]);
  readonly recentAssets = signal<DataGridRow[]>([]);
  readonly recentAssetsTotal = signal(0);
  readonly loading = signal(false);

  readonly assetColumns: readonly DataGridColumn[] = [
    { key: 'asset_tag', label: 'Asset Tag', type: 'mono' },
    { key: 'name', label: 'Device Name', type: 'text' },
    { key: 'serial', label: 'Serial', type: 'mono' },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'purchase_cost', label: 'Cost', type: 'currency', align: 'right' },
  ];

  readonly secondaryTotal = computed(() => {
    const s = this.summary();
    if (!s) return 0;
    return s.licenses_total + s.accessories_total + s.consumables_total + s.components_total;
  });

  readonly operationsAttentionCount = computed(() => {
    const s = this.summary();
    if (!s) return 0;
    return s.pending_checkout_requests + s.overdue_audits + s.active_maintenances;
  });

  readonly statusSummaryLine = computed(() => {
    const breakdown = this.summary()?.status_breakdown;
    if (!breakdown) return 'Live telemetry';
    return `${breakdown['deployed'] ?? 0} deployed · ${breakdown['deployable'] ?? 0} ready · ${breakdown['pending'] ?? 0} pending`;
  });

  readonly activeCompanyCount = computed(() => {
    if (this.authStore.isSuperUser()) {
      return 'ALL';
    }
    return String(this.authStore.userCompanyIds().length);
  });

  readonly companyScopeSummary = computed(() => {
    if (this.authStore.isSuperUser()) {
      return 'Unrestricted (Superuser)';
    }
    const ids = this.authStore.userCompanyIds();
    return ids.length > 0 ? `${ids.length} assigned company scope(s)` : 'Floater / Global items';
  });

  constructor(
    @Inject(AuthStore) readonly authStore: AuthStore,
    @Inject(InventoryApi) @Optional() private readonly api?: InventoryApi,
    @Inject(Router) @Optional() private readonly router?: Router,
  ) {}

  ngOnInit(): void {
    void this.loadDashboard();
  }

  async loadDashboard(): Promise<void> {
    if (!this.api || !this.authStore.isAuthenticated()) return;
    this.loading.set(true);
    try {
      const tasks: [
        Promise<StandardApiResponse<DashboardSummaryPayload>>,
        Promise<StandardApiResponse<DashboardCategoryRow[]>>,
        Promise<{ rows?: DataGridRow[]; total?: number }> | null,
      ] = [
        this.api.read<StandardApiResponse<DashboardSummaryPayload>>('/dashboard/summary'),
        this.api.read<StandardApiResponse<DashboardCategoryRow[]>>('/dashboard/categories'),
        this.authStore.can('assets.view') || this.authStore.isAdmin()
          ? this.api.records('/hardware', { limit: 10, sort: 'updated_at', order: 'desc' })
          : null,
      ];
      const [summaryRes, catRes, hwRes] = await Promise.allSettled(tasks);
      if (summaryRes.status === 'fulfilled' && summaryRes.value.payload) {
        this.summary.set(summaryRes.value.payload);
      }
      if (catRes.status === 'fulfilled' && Array.isArray(catRes.value.payload)) {
        this.categories.set(catRes.value.payload);
      }
      if (hwRes.status === 'fulfilled' && hwRes.value) {
        this.recentAssets.set(hwRes.value.rows ?? []);
        this.recentAssetsTotal.set(hwRes.value.total ?? 0);
      }
    } finally {
      this.loading.set(false);
    }
  }

  onAssetRowAction(event: { action: string; row: DataGridRow }): void {
    if (event.row.id !== undefined) {
      void this.router?.navigate(['/hardware', event.row.id]);
    }
  }
}

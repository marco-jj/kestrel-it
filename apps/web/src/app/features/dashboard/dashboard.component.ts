import { CommonModule } from '@angular/common';
import { Component, Inject, computed, signal } from '@angular/core';
import { AuthStore } from '../../core/auth/auth.store.js';
import {
  KestrelAsyncSelectComponent,
  KestrelDataGridComponent,
  KestrelSlideDrawerComponent,
  KestrelStatusBadgeComponent,
  type AsyncSelectOption,
  type DataGridColumn,
  type DataGridRow,
} from '../../shared/ui/index.js';

@Component({
  selector: 'kestrel-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    KestrelDataGridComponent,
    KestrelStatusBadgeComponent,
    KestrelSlideDrawerComponent,
    KestrelAsyncSelectComponent,
  ],
  template: `
    <section class="dashboard">
      <div class="header-row">
        <div>
          <h1>IT Asset Operations Cockpit</h1>
          <p class="subtitle">
            Precision Enterprise overview with real-time RBAC scoping and multi-company telemetry.
          </p>
        </div>
        <div class="header-actions">
          <span class="role-chip k-mono">
            {{ authStore.isSuperUser() ? 'SUPERUSER' : authStore.isAdmin() ? 'ADMIN' : 'USER' }}
          </span>
          <button type="button" class="k-btn k-btn-primary" (click)="openQuickDrawer()">
            Quick Checkout
          </button>
        </div>
      </div>

      <div class="kpi-grid">
        <article class="k-card kpi-card">
          <span class="kpi-label k-mono">HARDWARE INVENTORY</span>
          <strong class="kpi-value k-mono">Phase 2.3</strong>
          <div class="kpi-foot">
            <kestrel-status-badge statusMeta="deployable" label="API Contract Ready" />
          </div>
        </article>
        <article class="k-card kpi-card">
          <span class="kpi-label k-mono">SOFTWARE LICENSES</span>
          <strong class="kpi-value k-mono">Phase 3.1</strong>
          <div class="kpi-foot">
            <kestrel-status-badge statusMeta="deployed" label="Seat Propagation Spec" />
          </div>
        </article>
        <article class="k-card kpi-card">
          <span class="kpi-label k-mono">AUDIT &amp; COMPLIANCE</span>
          <strong class="kpi-value k-mono">Phase 3.2</strong>
          <div class="kpi-foot">
            <kestrel-status-badge statusMeta="pending" label="JSONB GIN Indexed" />
          </div>
        </article>
        <article class="k-card kpi-card">
          <span class="kpi-label k-mono">FMCS ACTIVE SCOPE</span>
          <strong class="kpi-value k-mono">{{ activeCompanyCount() }}</strong>
          <p class="kpi-note">{{ companyScopeSummary() }}</p>
        </article>
      </div>

      <div class="grid-section">
        <div class="section-header">
          <h2>Shared DataGrid &amp; Action Capability Blueprint</h2>
          <span class="k-mono section-meta">Server-side contract preview</span>
        </div>

        <kestrel-data-grid
          [columns]="previewColumns"
          [rows]="previewRows"
          [total]="previewRows.length"
          createLabel="Quick Checkout"
          (createClicked)="openQuickDrawer()"
          (rowAction)="onPreviewRowAction($event)"
        />
      </div>

      <kestrel-slide-drawer
        [open]="drawerOpen()"
        title="Quick Asset Checkout Preview"
        subtitle="Company-scoped FMCS selector preserves active table context."
        (closed)="drawerOpen.set(false)"
      >
        <div class="drawer-form">
          <kestrel-async-select
            label="Target Location (FMCS Scoped)"
            placeholder="Search locations within company scope..."
            [options]="sampleLocations"
            [companyId]="authStore.selectedCompanyId()"
            (quickCreate)="quickCreateMessage.set('Inline location creation triggered for: ' + ($event.query || 'New Location'))"
          />

          @if (quickCreateMessage()) {
            <div class="info-note k-mono">{{ quickCreateMessage() }}</div>
          }
        </div>

        <div drawer-footer>
          <button type="button" class="k-btn k-btn-secondary" (click)="drawerOpen.set(false)">
            Close
          </button>
          <button type="button" class="k-btn k-btn-primary" (click)="drawerOpen.set(false)">
            Confirm Preview
          </button>
        </div>
      </kestrel-slide-drawer>
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
export class DashboardComponent {
  readonly drawerOpen = signal<boolean>(false);
  readonly quickCreateMessage = signal<string | null>(null);

  readonly previewColumns: readonly DataGridColumn[] = [
    { key: 'asset_tag', label: 'Asset Tag', type: 'mono' },
    { key: 'name', label: 'Device Name', type: 'text' },
    { key: 'serial', label: 'Serial', type: 'mono' },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'purchase_cost', label: 'Book Value', type: 'currency', align: 'right' },
  ];

  readonly previewRows: readonly DataGridRow[] = [
    {
      id: 1,
      asset_tag: 'KST-00104',
      name: 'MacBook Pro 16" M4',
      serial: 'C02YM498LVDQ',
      status: 'deployable',
      status_label: 'Ready to Deploy',
      purchase_cost: '$2,899.00',
      available_actions: { checkout: true, update: true, clone: true },
    },
    {
      id: 2,
      asset_tag: 'KST-00105',
      name: 'Dell PowerEdge R760',
      serial: '9HX2R760SRV',
      status: 'deployed',
      status_label: 'Deployed — Rack B4',
      purchase_cost: '$6,450.00',
      available_actions: { checkin: true, update: true },
    },
    {
      id: 3,
      asset_tag: 'KST-00106',
      name: 'ThinkPad X1 Carbon Gen 12',
      serial: 'PF4X1GEN1288',
      status: 'pending',
      status_label: 'Pending RMA',
      purchase_cost: '$1,940.00',
      available_actions: { update: true, delete: false },
    },
  ];

  readonly sampleLocations: readonly AsyncSelectOption[] = [
    { id: 1, text: 'Milan HQ — Rack Room 1', companyId: 10 },
    { id: 2, text: 'Rome Ops Hub', companyId: 20 },
    { id: 3, text: 'Global Remote Pool', companyId: null },
  ];

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

  constructor(@Inject(AuthStore) readonly authStore: AuthStore) {}

  openQuickDrawer(): void {
    this.quickCreateMessage.set(null);
    this.drawerOpen.set(true);
  }

  onPreviewRowAction(event: { action: string; row: DataGridRow }): void {
    this.quickCreateMessage.set(
      `Triggered "${event.action}" for ${String(event.row['asset_tag'] ?? event.row.id)}`,
    );
    this.drawerOpen.set(true);
  }
}

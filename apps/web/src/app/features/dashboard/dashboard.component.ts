import { CommonModule } from '@angular/common';
import { Component, Inject, computed } from '@angular/core';
import { AuthStore } from '../../core/auth/auth.store.js';

@Component({
  selector: 'kestrel-dashboard',
  standalone: true,
  imports: [CommonModule],
  template: `
    <section class="dashboard">
      <div class="header-row">
        <h1>IT Asset Overview</h1>
        <span class="role-chip">
          {{ authStore.isSuperUser() ? 'Superuser' : authStore.isAdmin() ? 'Admin' : 'Standard User' }}
        </span>
      </div>

      <div class="kpi-grid">
        <article class="kestrel-card">
          <h3>Hardware Assets</h3>
          <p class="kpi-note">Ready in Phase 2 (Piano 2.3)</p>
        </article>
        <article class="kestrel-card">
          <h3>Software Licenses</h3>
          <p class="kpi-note">Ready in Phase 3 (Piano 3.1)</p>
        </article>
        <article class="kestrel-card">
          <h3>Accessories &amp; Consumables</h3>
          <p class="kpi-note">Ready in Phase 3 (Piano 3.1)</p>
        </article>
        <article class="kestrel-card">
          <h3>Scoped Companies</h3>
          <p class="kpi-note">{{ companyScopeSummary() }}</p>
        </article>
      </div>
    </section>
  `,
  styles: [
    `
      .header-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 1.25rem;
      }
      .role-chip {
        background: #e0f2fe;
        color: #0369a1;
        padding: 0.3rem 0.75rem;
        border-radius: 999px;
        font-size: 0.8rem;
        font-weight: 600;
      }
      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 1rem;
      }
      .kpi-note {
        color: var(--kestrel-muted);
        margin-bottom: 0;
      }
    `,
  ],
})
export class DashboardComponent {
  readonly companyScopeSummary = computed(() => {
    if (this.authStore.isSuperUser()) {
      return 'Unrestricted (Superuser)';
    }
    const ids = this.authStore.userCompanyIds();
    return ids.length > 0 ? `${ids.length} assigned company scope(s)` : 'Floater / Global items';
  });

  constructor(@Inject(AuthStore) readonly authStore: AuthStore) {}
}

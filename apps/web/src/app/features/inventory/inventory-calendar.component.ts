import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { formatDisplayDate } from '../../shared/ui/display-date.js';
import { InventoryApi, inventoryError } from './inventory-api.js';

type CalendarEvent = {
  id: number;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  url: string;
  extendedProps: { source_type: string; event_type: string; source_id: number };
};
const monthKey = (value: Date) => value.toISOString().slice(0, 10);
const eventFilters = [
  ['All events', ''],
  ['Audits', 'asset.audit_due'],
  ['Returns', 'asset.expected_checkin'],
  ['Checkouts', 'asset.checkout'],
  ['Warranties', 'asset.warranty_expiration'],
  ['End of life', 'asset.eol'],
  ['License dates', 'license.expiration,license.termination'],
  ['Maintenance', 'maintenance.start'],
  ['User dates', 'user.start_date,user.end_date'],
  ['Reservations', 'request.reservation'],
];

@Component({
  selector: 'kestrel-inventory-calendar',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <header>
      <h1>Inventory calendar</h1>
      <label
        >Event type
        <select [(ngModel)]="filter" (ngModelChange)="load()">
          @for (option of filters; track option[1]) {
            <option [value]="option[1]">{{ option[0] }}</option>
          }
        </select>
      </label>
    </header>
    <div class="month-controls">
      <button
        type="button"
        class="k-btn k-btn-secondary"
        aria-label="Previous month"
        (click)="move(-1)"
      >
        ‹
      </button>
      <h2 aria-live="polite">{{ label() }}</h2>
      <button type="button" class="k-btn k-btn-secondary" aria-label="Next month" (click)="move(1)">
        ›
      </button>
      <button type="button" class="k-btn k-btn-secondary" (click)="today()">Today</button>
    </div>
    @if (error()) {
      <p role="alert">{{ error() }}</p>
    }
    @if (loading()) {
      <p role="status">Loading events…</p>
    }
    @if (truncated()) {
      <p role="status">Showing the first 500 events. Filter by event type to narrow results.</p>
    }
    <div class="month" aria-label="Month view">
      @for (day of weekdays; track day) {
        <div class="weekday">{{ day }}</div>
      }
      @for (day of days(); track day.key) {
        <div class="day" [class.other-month]="!day.inMonth">
          <time [attr.datetime]="day.key" [attr.aria-label]="formatDate(day.key)">{{ day.day }}</time>
          @for (event of day.events; track event.id) {
            <a
              [routerLink]="pathFor(event)"
              [queryParams]="paramsFor(event)"
              [attr.data-source]="event.extendedProps.source_type"
            >
              {{ event.title }}
            </a>
          }
        </div>
      }
    </div>
    <ul class="agenda" aria-label="Monthly events">
      @for (event of events(); track event.id) {
        <li>
          <time [attr.datetime]="event.start">{{ formatDate(event.start) }}</time>
          <a [routerLink]="pathFor(event)" [queryParams]="paramsFor(event)">{{ event.title }}</a>
        </li>
      } @empty {
        <li>No events this month.</li>
      }
    </ul>
  `,
  styles: [
    `
      header,
      .month-controls {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.75rem;
        margin-bottom: 0.85rem;
      }
      h1 {
        font-size: 1.6rem;
        font-weight: 640;
        margin-right: auto;
      }
      h2 {
        font-size: 1.1rem;
        min-width: 10rem;
        text-align: center;
      }
      select {
        margin-left: 0.4rem;
        border: 1px solid var(--kestrel-border);
        border-radius: 0.4rem;
        padding: 0.35rem;
      }
      .month {
        display: grid;
        grid-template-columns: repeat(7, minmax(0, 1fr));
        border-top: 1px solid var(--kestrel-border);
        border-left: 1px solid var(--kestrel-border);
      }
      .weekday,
      .day {
        border-right: 1px solid var(--kestrel-border);
        border-bottom: 1px solid var(--kestrel-border);
        padding: 0.45rem;
      }
      .weekday {
        font-weight: 600;
      }
      .day {
        min-height: 5.5rem;
      }
      .other-month {
        background: var(--kestrel-surface-subtle);
      }
      .day a {
        display: block;
        font-size: 0.78rem;
        border-inline-start: 2px solid var(--kestrel-accent);
        padding: 0.18rem 0.3rem;
        margin-top: 0.2rem;
        overflow-wrap: anywhere;
      }
      a:hover {
        text-decoration: underline;
      }
      .agenda {
        display: none;
      }
      [role='alert'] {
        color: var(--kestrel-danger);
      }
      @media (max-width: 740px) {
        .month {
          display: none;
        }
        .agenda {
          display: grid;
          gap: 0.8rem;
        }
        .agenda li {
          display: flex;
          flex-wrap: wrap;
          gap: 0.7rem;
        }
      }
    `,
  ],
})
export class InventoryCalendarComponent implements OnInit {
  private readonly api = inject(InventoryApi);
  readonly month = signal(this.currentMonth());
  readonly events = signal<CalendarEvent[]>([]);
  readonly truncated = signal(false);
  readonly error = signal('');
  readonly loading = signal(false);
  readonly weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  readonly filters = eventFilters;
  readonly formatDate = formatDisplayDate;
  readonly label = computed(() =>
    this.month().toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  );
  private revision = 0;
  filter = '';

  readonly days = computed(() => {
    const value = this.month();
    const start = new Date(value);
    start.setUTCDate(1 - ((start.getUTCDay() + 6) % 7));
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setUTCDate(date.getUTCDate() + index);
      const key = monthKey(date);
      const inMonth = date.getUTCMonth() === value.getUTCMonth();
      return {
        key,
        day: date.getUTCDate(),
        inMonth,
        events: inMonth
          ? this.events().filter((event) => {
              const from = event.start.slice(0, 10);
              return event.end ? key >= from && key < event.end.slice(0, 10) : key === from;
            })
          : [],
      };
    });
  });

  ngOnInit(): void {
    void this.load();
  }
  private currentMonth() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  move(delta: number) {
    const value = this.month();
    this.month.set(new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + delta, 1)));
    void this.load();
  }

  today() {
    this.month.set(this.currentMonth());
    void this.load();
  }

  pathFor(event: CalendarEvent) {
    return event.url.split('?')[0];
  }
  paramsFor(event: CalendarEvent) {
    return event.url.includes('?detail=') ? { detail: event.extendedProps.source_id } : {};
  }

  async load() {
    const revision = ++this.revision;
    const value = this.month();
    this.loading.set(true);
    this.error.set('');
    this.events.set([]);
    this.truncated.set(false);
    try {
      const response = await this.api.read<{ events: CalendarEvent[]; truncated: boolean }>(
        '/calendar/events',
        {
          start: monthKey(value),
          end: monthKey(new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1))),
          ...(this.filter ? { event_type: this.filter } : {}),
        },
      );
      if (revision !== this.revision) return;
      this.events.set(response.events);
      this.truncated.set(response.truncated);
    } catch (error) {
      if (revision === this.revision) this.error.set(inventoryError(error));
    } finally {
      if (revision === this.revision) this.loading.set(false);
    }
  }
}

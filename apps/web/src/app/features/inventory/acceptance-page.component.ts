import {
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { distinctUntilChanged, map } from 'rxjs';
import { InventoryApi, inventoryError } from './inventory-api.js';

interface Acceptance {
  id: number;
  asset_id: number;
  item_type?: string;
  asset_tag: string | null;
  asset_name: string | null;
  state: 'pending' | 'accepted' | 'declined';
  eula?: string | null;
  requires_signature?: boolean;
  has_eula: boolean;
  has_signature: boolean;
}

@Component({
  selector: 'kestrel-acceptance-page',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <article>
      <header>
        <h1>
          {{
            detailId() ? 'Checkout acceptance' : history ? 'EULA history' : 'Checkout acceptances'
          }}
        </h1>
        <nav>
          <a routerLink="/account/accept">Pending acceptance</a>
          <a routerLink="/account/eulas">EULA history</a>
        </nav>
      </header>
      @if (error()) {
        <p role="alert">{{ error() }}</p>
      }
      @if (loading()) {
        <p role="status">Loading…</p>
      }
      @if (record(); as item) {
        <section>
          <h2>{{ item.asset_tag }} {{ item.asset_name }}</h2>
          <p>State: {{ item.state }}</p>
          @if (item.eula) {
            <div class="agreement">{{ item.eula }}</div>
          }
          @if (item.state === 'pending') {
            @if (item.requires_signature) {
              <p>Sign below to accept this checkout.</p>
              <canvas
                #signature
                width="720"
                height="200"
                aria-label="Signature pad"
                (pointerdown)="begin($event)"
                (pointermove)="draw($event)"
                (pointerup)="end()"
                (pointercancel)="end()"
                (lostpointercapture)="end()"
              ></canvas>
              <button class="k-btn k-btn-secondary" type="button" (click)="clear()">
                Clear signature
              </button>
            }
            <label>Note <textarea rows="3" [(ngModel)]="note"></textarea></label>
            <div class="actions">
              <button
                type="button"
                class="k-btn k-btn-secondary"
                [disabled]="saving()"
                (click)="respond('decline')"
              >
                Decline
              </button>
              <button
                type="button"
                class="k-btn k-btn-primary"
                [disabled]="saving()"
                (click)="respond('accept')"
              >
                Accept
              </button>
            </div>
          }
          <div class="actions">
            @if (item.has_eula) {
              <button
                type="button"
                class="k-btn k-btn-secondary"
                (click)="download(item.id, 'eula')"
              >
                Download signed EULA
              </button>
            }
            @if (item.has_signature) {
              <button
                type="button"
                class="k-btn k-btn-secondary"
                (click)="download(item.id, 'signature')"
              >
                Download signature
              </button>
            }
          </div>
        </section>
      } @else if (!detailId() && !loading()) {
        <ul>
          @for (item of rows(); track item.id) {
            <li>
              <a [routerLink]="['/account/accept', item.id]"
                >{{ item.asset_tag || '#' + item.asset_id }} {{ item.asset_name }}</a
              >
              <span>{{ item.state }}</span>
              @if (item.has_eula) {
                <button
                  type="button"
                  class="k-btn k-btn-secondary"
                  (click)="download(item.id, 'eula')"
                >
                  Download PDF
                </button>
              }
            </li>
          } @empty {
            <li>No {{ history ? 'historical' : 'pending' }} acceptances.</li>
          }
        </ul>
        @if (totalPages() > 1) {
          <div class="actions">
            <button
              type="button"
              class="k-btn k-btn-secondary"
              [disabled]="page() <= 1"
              (click)="paginate(-1)"
            >
              Previous
            </button>
            <button
              type="button"
              class="k-btn k-btn-secondary"
              [disabled]="page() >= totalPages()"
              (click)="paginate(1)"
            >
              Next
            </button>
          </div>
        }
      }
    </article>
  `,
  styles: [
    `
      article {
        max-width: 58rem;
      }
      header,
      nav,
      .actions,
      li {
        display: flex;
        gap: 0.65rem;
        flex-wrap: wrap;
        align-items: center;
      }
      header,
      li {
        justify-content: space-between;
      }
      h1 {
        font-size: 1.6rem;
        font-weight: 640;
      }
      h2 {
        font-size: 1.22rem;
        font-weight: 600;
      }
      nav a,
      li a {
        text-decoration: underline;
      }
      section,
      label {
        display: grid;
        gap: 0.65rem;
        margin-top: 1rem;
      }
      .agreement,
      li,
      textarea {
        border: 1px solid var(--kestrel-border);
        border-radius: 0.45rem;
        padding: 0.75rem;
      }
      .agreement {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      li {
        margin-top: 0.55rem;
      }
      canvas {
        width: min(100%, 720px);
        height: auto;
        touch-action: none;
        background: white;
        border: 1px solid var(--kestrel-border);
        border-radius: 0.45rem;
      }
      [role='alert'] {
        color: var(--kestrel-danger);
      }
    `,
  ],
})
export class AcceptancePageComponent implements OnInit {
  @ViewChild('signature') private canvas?: ElementRef<HTMLCanvasElement>;
  private readonly api = inject(InventoryApi);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  readonly detailId = signal<number | null>(null);
  readonly history = this.route.snapshot.routeConfig?.path === 'account/eulas';
  readonly record = signal<Acceptance | null>(null);
  readonly rows = signal<Acceptance[]>([]);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly page = signal(1);
  readonly totalPages = signal(0);
  note = '';
  private drawing = false;
  private signed = false;
  private loadSequence = 0;
  private routeSequence = 0;

  ngOnInit(): void {
    this.route.paramMap
      .pipe(
        map((params) => Number(params.get('id')) || null),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((id) => {
        this.routeSequence++;
        this.detailId.set(id);
        this.record.set(null);
        this.saving.set(false);
        this.note = '';
        this.clear();
        void this.load();
      });
  }

  async load(): Promise<void> {
    const request = ++this.loadSequence;
    const id = this.detailId();
    this.loading.set(true);
    this.error.set('');
    try {
      if (id !== null) {
        const item = await this.api.read<Acceptance>(`/account/accept/${id}`);
        if (request === this.loadSequence) this.record.set(item);
      } else {
        const data = await this.api.read<{ rows: Acceptance[]; total_pages: number }>(
          this.history ? '/account/eulas' : '/account/accept',
          { limit: 20, page: this.page() },
        );
        if (request !== this.loadSequence) return;
        this.rows.set(data.rows);
        this.totalPages.set(data.total_pages);
      }
    } catch (error) {
      if (request === this.loadSequence) this.error.set(inventoryError(error));
    } finally {
      if (request === this.loadSequence) this.loading.set(false);
    }
  }

  paginate(offset: number): void {
    this.page.update((page) => page + offset);
    void this.load();
  }

  private point(event: PointerEvent, canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect();
    return [
      ((event.clientX - rect.left) * canvas.width) / rect.width,
      ((event.clientY - rect.top) * canvas.height) / rect.height,
    ] as const;
  }

  begin(event: PointerEvent) {
    const canvas = this.canvas?.nativeElement;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    this.drawing = true;
    context.strokeStyle = '#172033';
    context.lineWidth = 3;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(...this.point(event, canvas));
  }

  draw(event: PointerEvent) {
    const canvas = this.canvas?.nativeElement;
    const context = canvas?.getContext('2d');
    if (!this.drawing || !canvas || !context) return;
    context.lineTo(...this.point(event, canvas));
    context.stroke();
    this.signed = true;
  }

  end(): void {
    this.drawing = false;
  }

  clear() {
    const canvas = this.canvas?.nativeElement;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    this.signed = false;
    this.drawing = false;
  }

  async respond(decision: 'accept' | 'decline') {
    const item = this.record();
    if (!item || this.saving()) return;
    this.error.set('');
    if (decision === 'accept' && item.requires_signature && !this.signed) {
      this.error.set('Sign the form before accepting.');
      return;
    }
    const route = this.routeSequence;
    this.saving.set(true);
    try {
      await this.api.write('POST', `/account/accept/${item.id}`, {
        decision,
        note: this.note.trim() || null,
        ...(decision === 'accept' && this.signed && this.canvas
          ? { signature: this.canvas.nativeElement.toDataURL('image/png') }
          : {}),
      });
      if (route === this.routeSequence) await this.load();
    } catch (error) {
      if (route === this.routeSequence) this.error.set(inventoryError(error));
    } finally {
      if (route === this.routeSequence) this.saving.set(false);
    }
  }

  async download(id: number, kind: 'eula' | 'signature') {
    try {
      const content = await this.api.blob(`/account/accept/${id}/${kind}`);
      const url = URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = url;
      link.download = `acceptance-${id}.${kind === 'eula' ? 'pdf' : 'png'}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }
}

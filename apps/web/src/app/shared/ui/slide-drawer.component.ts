import { A11yModule } from '@angular/cdk/a11y';
import { CommonModule } from '@angular/common';
import { Component, EventEmitter, HostListener, Input, Output } from '@angular/core';

@Component({
  selector: 'kestrel-slide-drawer',
  standalone: true,
  imports: [CommonModule, A11yModule],
  template: `
    @if (open) {
      <div class="drawer-backdrop" (click)="close()">
        <aside
          class="drawer-panel"
          [attr.data-size]="size"
          role="dialog"
          aria-modal="true"
          [attr.aria-label]="title || 'Detail drawer'"
          cdkTrapFocus
          [cdkTrapFocusAutoCapture]="true"
          (click)="$event.stopPropagation()"
        >
          <header class="drawer-header">
            <div class="drawer-heading">
              <h2>{{ title }}</h2>
              @if (subtitle) {
                <p class="drawer-subtitle">{{ subtitle }}</p>
              }
            </div>
            <button
              type="button"
              class="k-btn k-btn-ghost close-btn"
              (click)="close()"
              aria-label="Close drawer"
            >
              <span class="k-kbd">Esc</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M18 6 6 18M6 6l12 12" stroke-linecap="round" />
              </svg>
            </button>
          </header>

          <div class="drawer-body">
            <ng-content />
          </div>

          <footer class="drawer-footer">
            <ng-content select="[drawer-footer]" />
          </footer>
        </aside>
      </div>
    }
  `,
  styles: [
    `
      .drawer-backdrop {
        position: fixed;
        inset: 0;
        z-index: 60;
        background: rgba(9, 9, 11, 0.52);
        backdrop-filter: blur(4px);
        display: flex;
        justify-content: flex-end;
      }
      .drawer-panel {
        width: min(460px, 100vw);
        height: 100dvh;
        background: var(--kestrel-surface);
        border-left: 1px solid var(--kestrel-border);
        box-shadow: var(--kestrel-shadow-lg);
        display: flex;
        flex-direction: column;
        animation: kestrel-slide-in 180ms var(--kestrel-ease-spring);
      }
      .drawer-panel[data-size='lg'] {
        width: min(600px, 100vw);
      }
      .drawer-panel[data-size='xl'] {
        width: min(780px, 100vw);
      }
      .drawer-header {
        padding: 1rem 1.25rem;
        border-bottom: 1px solid var(--kestrel-border);
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
      }
      .drawer-heading h2 {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
        letter-spacing: -0.015em;
      }
      .drawer-subtitle {
        margin: 0.25rem 0 0;
        color: var(--kestrel-muted);
        font-size: 0.8rem;
      }
      .close-btn {
        padding: 0.3rem 0.5rem;
        min-height: 32px;
      }
      .drawer-body {
        flex: 1;
        overflow-y: auto;
        padding: 1.25rem;
      }
      .drawer-footer:empty {
        display: none;
      }
      .drawer-footer {
        padding: 0.9rem 1.25rem;
        border-top: 1px solid var(--kestrel-border);
        background: var(--kestrel-surface-subtle);
        display: flex;
        justify-content: flex-end;
        gap: 0.65rem;
      }
      @keyframes kestrel-slide-in {
        from {
          transform: translateX(24px);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }
    `,
  ],
})
export class KestrelSlideDrawerComponent {
  @Input() open = false;
  @Input() title = '';
  @Input() subtitle = '';
  @Input() size: 'md' | 'lg' | 'xl' = 'md';

  @Output() closed = new EventEmitter<void>();

  close(): void {
    this.closed.emit();
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (this.open && event.key === 'Escape') {
      this.close();
    }
  }
}

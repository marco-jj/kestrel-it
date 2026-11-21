import { CommonModule } from '@angular/common';
import { Component, Input, computed, signal } from '@angular/core';
import type { StatusMetaType } from '@kestrel-it/shared';

export type KestrelStatusTone = StatusMetaType;

export interface StatusBadgeConfig {
  tone: KestrelStatusTone;
  label: string;
  dotColor: string;
}

export function resolveStatusBadgeConfig(
  statusMeta: string | null | undefined,
  customLabel?: string,
): StatusBadgeConfig {
  const normalized = (statusMeta ?? '').trim().toLowerCase();

  if (
    normalized === 'deployable' ||
    normalized === 'ready' ||
    normalized === 'ready to deploy' ||
    normalized === 'rtd'
  ) {
    return {
      tone: 'deployable',
      label: customLabel || 'Ready to Deploy',
      dotColor: 'var(--kestrel-success)',
    };
  }

  if (normalized === 'deployed' || normalized === 'assigned' || normalized === 'checked_out') {
    return {
      tone: 'deployed',
      label: customLabel || 'Deployed',
      dotColor: 'var(--kestrel-info)',
    };
  }

  if (normalized === 'pending' || normalized === 'maintenance') {
    return {
      tone: 'pending',
      label: customLabel || 'Pending',
      dotColor: 'var(--kestrel-warning)',
    };
  }

  if (
    normalized === 'undeployable' ||
    normalized === 'broken' ||
    normalized === 'overdue' ||
    normalized === 'lost'
  ) {
    return {
      tone: 'undeployable',
      label: customLabel || 'Undeployable',
      dotColor: 'var(--kestrel-danger)',
    };
  }

  if (normalized === 'archived' || normalized === 'retired') {
    return {
      tone: 'archived',
      label: customLabel || 'Archived',
      dotColor: 'var(--kestrel-muted)',
    };
  }

  return {
    tone: 'archived',
    label: customLabel || (normalized ? statusMeta!.trim() : 'Archived'),
    dotColor: 'var(--kestrel-muted)',
  };
}

@Component({
  selector: 'kestrel-status-badge',
  standalone: true,
  imports: [CommonModule],
  template: `
    <span class="badge" [attr.data-tone]="config().tone">
      <span class="dot" [style.background]="config().dotColor" aria-hidden="true"></span>
      <span>{{ config().label }}</span>
      @if (codeSignal()) {
        <span class="code k-mono">{{ codeSignal() }}</span>
      }
    </span>
  `,
  styles: [
    `
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.18rem 0.55rem;
        border-radius: 999px;
        font-size: 0.75rem;
        font-weight: 600;
        line-height: 1.3;
        border: 1px solid var(--kestrel-border);
        background: var(--kestrel-surface-subtle);
        color: var(--kestrel-ink);
        white-space: nowrap;
      }
      .badge[data-tone='deployable'] {
        background: var(--kestrel-success-subtle);
        border-color: rgba(16, 185, 129, 0.28);
      }
      .badge[data-tone='deployed'] {
        background: var(--kestrel-info-subtle);
        border-color: rgba(2, 132, 199, 0.28);
      }
      .badge[data-tone='pending'] {
        background: var(--kestrel-warning-subtle);
        border-color: rgba(217, 119, 6, 0.28);
      }
      .badge[data-tone='undeployable'] {
        background: var(--kestrel-danger-subtle);
        border-color: rgba(225, 29, 72, 0.28);
      }
      .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .code {
        color: var(--kestrel-muted);
        font-size: 0.7rem;
      }
    `,
  ],
})
export class KestrelStatusBadgeComponent {
  readonly statusMetaSignal = signal<string | null | undefined>('archived');
  readonly labelSignal = signal<string | undefined>(undefined);
  readonly codeSignal = signal<string | null | undefined>(null);

  readonly config = computed(() =>
    resolveStatusBadgeConfig(this.statusMetaSignal(), this.labelSignal()),
  );

  @Input() set statusMeta(value: string | null | undefined) {
    this.statusMetaSignal.set(value);
  }

  @Input() set label(value: string | undefined) {
    this.labelSignal.set(value);
  }

  @Input() set code(value: string | null | undefined) {
    this.codeSignal.set(value);
  }
}

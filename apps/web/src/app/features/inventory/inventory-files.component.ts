import { Component, Input, OnChanges, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { KestrelDataGridComponent, type DataGridRow } from '../../shared/ui/data-grid.component.js';
import { InventoryApi, inventoryError } from './inventory-api.js';

export function saveDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

@Component({
  selector: 'kestrel-inventory-files',
  imports: [FormsModule, KestrelDataGridComponent],
  template: `
    @if (canWrite) {
      <form class="k-card upload" (ngSubmit)="upload()">
        <label
          >Attachments <input name="attachments" type="file" multiple (change)="choose($event)"
        /></label>
        <label>Note <input name="note" [(ngModel)]="note" maxlength="5000" /></label>
        <button class="k-btn k-btn-primary" type="submit" [disabled]="busy() || !files.length">
          Upload files
        </button>
      </form>
    }
    @if (error()) {
      <p role="alert">{{ error() }}</p>
    }
    @if (message()) {
      <p role="status">{{ message() }}</p>
    }
    <kestrel-data-grid
      [rows]="rows()"
      [columns]="columns"
      [total]="total()"
      [page]="page"
      [creatable]="false"
      [selectable]="false"
      [loading]="busy()"
      emptyTitle="No attachments"
      (pageChanged)="page = $event; load()"
      (searchChanged)="search = $event; page = 1; load()"
    />
    @if (rows().length) {
      <ul class="files">
        @for (row of rows(); track row.id) {
          <li>
            <button type="button" class="k-btn k-btn-secondary" (click)="download(row)">
              Download {{ row['filename'] }}
            </button>
            @if (canWrite) {
              @if (pending() === row.id) {
                <button type="button" class="k-btn k-btn-secondary" (click)="pending.set(null)">
                  Cancel
                </button>
                <button type="button" class="k-btn k-btn-primary" (click)="remove(row)">
                  Confirm delete
                </button>
              } @else {
                <button
                  type="button"
                  class="k-btn k-btn-secondary"
                  (click)="pending.set(row.id ?? null)"
                >
                  Delete {{ row['filename'] }}
                </button>
              }
            }
          </li>
        }
      </ul>
    }
  `,
  styles: [
    `
      .upload,
      .files li {
        display: flex;
        align-items: end;
        gap: 0.75rem;
        flex-wrap: wrap;
        margin-block: 1rem;
      }
      .upload {
        padding: 1rem;
      }
      label {
        display: grid;
        gap: 0.3rem;
      }
    `,
  ],
})
export class InventoryFilesComponent implements OnChanges {
  @Input({ required: true }) resource!: string;
  @Input({ required: true }) itemId!: number;
  @Input() canWrite = false;
  private readonly api = inject(InventoryApi);
  readonly rows = signal<DataGridRow[]>([]);
  readonly total = signal(0);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly message = signal('');
  readonly pending = signal<number | string | null>(null);
  readonly columns = [
    { key: 'filename', label: 'File' },
    { key: 'note', label: 'Note' },
    { key: 'created_at', label: 'Uploaded' },
  ];
  files: File[] = [];
  note = '';
  search = '';
  page = 1;
  private revision = 0;

  get path() {
    return `/${this.resource}/${this.itemId}/files`;
  }

  ngOnChanges() {
    this.page = 1;
    this.pending.set(null);
    void this.load();
  }

  choose(event: Event) {
    this.files = Array.from((event.target as HTMLInputElement).files ?? []);
  }

  async load() {
    const revision = ++this.revision;
    this.busy.set(true);
    this.error.set('');
    try {
      const data = await this.api.records(this.path, { page: this.page, search: this.search });
      if (revision !== this.revision) return;
      this.rows.set(data.rows);
      this.total.set(data.total);
    } catch (error) {
      if (revision === this.revision) this.error.set(inventoryError(error));
    } finally {
      if (revision === this.revision) this.busy.set(false);
    }
  }

  async upload() {
    const body = new FormData();
    for (const file of this.files) body.append('file', file);
    body.append('notes', this.note);
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.write('POST', this.path, body);
      this.files = [];
      this.note = '';
      this.message.set('Attachments uploaded');
      await this.load();
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.busy.set(false);
    }
  }

  async download(row: DataGridRow) {
    try {
      saveDownload(await this.api.blob(`${this.path}/${row.id}`), String(row['filename']));
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  async remove(row: DataGridRow) {
    try {
      await this.api.write('DELETE', `${this.path}/${row.id}/delete`);
      this.pending.set(null);
      this.message.set('Attachment deleted');
      await this.load();
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }
}

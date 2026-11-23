import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IMPORT_TYPES, type ImportType, type StandardApiResponse } from '@kestrel-it/shared';
import { InventoryApi, inventoryError } from './inventory-api.js';
import { saveDownload } from './inventory-files.component.js';

interface Upload {
  id: number;
  name: string;
  import_type: ImportType | null;
  state?: string;
}
interface Preview extends Upload {
  header_row: string[];
  first_row: string[];
  fields: string[];
  suggested_map: Record<string, string | null>;
  field_map: Record<string, string> | null;
}
interface Run {
  state: string;
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  errored: number;
  error?: string;
  update_existing?: boolean;
  preserve_blanks?: boolean;
  send_welcome?: boolean;
}
const labels: Record<ImportType, string> = {
  asset: 'Assets',
  assetHistory: 'Asset History',
  assetModel: 'Asset Models',
  user: 'Users',
  license: 'Licenses',
  accessory: 'Accessories',
  consumable: 'Consumables',
  component: 'Components',
  location: 'Locations',
  category: 'Categories',
  manufacturer: 'Manufacturers',
  supplier: 'Suppliers',
};

@Component({
  selector: 'kestrel-import-page',
  imports: [FormsModule],
  template: `
    <h1>CSV imports</h1>
    <form class="toolbar" (ngSubmit)="upload()">
      <label
        >CSV files <input type="file" multiple accept=".csv,text/csv" (change)="choose($event)"
      /></label>
      <button type="submit" class="k-btn k-btn-primary" [disabled]="!files.length || busy()">
        Upload CSV files
      </button>
    </form>
    @if (error()) {
      <p role="alert">{{ error() }}</p>
    }
    @if (message()) {
      <p role="status">{{ message() }}</p>
    }
    <div class="columns">
      <section>
        <h2>Uploaded files</h2>
        <ul>
          @for (file of uploads(); track file.id) {
            <li class="toolbar">
              <button class="k-btn k-btn-secondary" (click)="open(file)">{{ file.name }}</button>
              <span>{{ file.state }}</span>
              <button class="k-btn k-btn-secondary" (click)="download(file)">Download</button>
              @if (deleting() === file.id) {
                <button class="k-btn k-btn-secondary" (click)="deleting.set(null)">Cancel</button>
                <button class="k-btn k-btn-primary" (click)="remove(file)">Confirm delete</button>
              } @else {
                <button
                  class="k-btn k-btn-secondary"
                  [disabled]="file.state === 'queued' || file.state === 'running'"
                  (click)="deleting.set(file.id)"
                >
                  Delete
                </button>
              }
            </li>
          } @empty {
            <li>No CSV uploads.</li>
          }
        </ul>
        @if (total() > 20) {
          <div class="toolbar">
            <button
              class="k-btn k-btn-secondary"
              [disabled]="page === 1"
              (click)="page = page - 1; load()"
            >
              Previous
            </button>
            <button
              class="k-btn k-btn-secondary"
              [disabled]="page * 20 >= total()"
              (click)="page = page + 1; load()"
            >
              Next
            </button>
          </div>
        }
      </section>
      @if (preview(); as file) {
        <section>
          <h2>{{ file.name }}</h2>
          <label
            >Import type
            <select
              [(ngModel)]="type"
              (ngModelChange)="loadMapping(file.id)"
              [disabled]="mappingLocked()"
            >
              @for (value of types; track value) {
                <option [ngValue]="value">{{ names[value] }}</option>
              }
            </select></label
          >
          <h3>Column mapping</h3>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>CSV column</th>
                  <th>First row</th>
                  <th>Import as</th>
                </tr>
              </thead>
              <tbody>
                @for (header of file.header_row; track $index; let index = $index) {
                  <tr>
                    <th scope="row">{{ header }}</th>
                    <td>{{ file.first_row[index] }}</td>
                    <td>
                      <select
                        [attr.aria-label]="'Map ' + header"
                        [(ngModel)]="mapping[index]"
                        [disabled]="mappingLocked()"
                      >
                        <option [ngValue]="null">Do not import</option>
                        @for (field of file.fields; track field) {
                          <option [ngValue]="field">{{ title(field) }}</option>
                        }
                      </select>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="toolbar">
            <label class="check"
              ><input type="checkbox" [(ngModel)]="updateExisting" [disabled]="mappingLocked()" />
              Update existing records</label
            >
            <label class="check"
              ><input type="checkbox" [(ngModel)]="preserveBlanks" [disabled]="mappingLocked()" />
              Preserve values for blank cells</label
            >
            @if (type === 'user') {
              <label class="check"
                ><input type="checkbox" [(ngModel)]="sendWelcome" [disabled]="mappingLocked()" />
                Send welcome email</label
              >
            }
          </div>
          <button
            class="k-btn k-btn-primary"
            [disabled]="busy() || locked()"
            (click)="process(file.id)"
          >
            {{ run()?.state === 'failed' ? 'Resume CSV' : 'Process CSV' }}
          </button>
          @if (run(); as progress) {
            <h3>Import progress</h3>
            <p role="status">
              {{ progress.state }} · {{ progress.processed }} processed ·
              {{ progress.created }} created · {{ progress.updated }} updated ·
              {{ progress.skipped }} skipped · {{ progress.errored }} errors
            </p>
            @if (progress.error) {
              <p role="alert">{{ progress.error }}</p>
            }
            @if (errors().length) {
              <ul>
                @for (item of errors(); track item.row_number) {
                  <li>Row {{ item.row_number }}: {{ item.message }}</li>
                }
              </ul>
              @if (errorTotal() > 20) {
                <button
                  class="k-btn k-btn-secondary"
                  [disabled]="errorPage === 1"
                  (click)="errorPage = errorPage - 1; progressFor(file.id)"
                >
                  Previous errors
                </button>
                <button
                  class="k-btn k-btn-secondary"
                  [disabled]="errorPage * 20 >= errorTotal()"
                  (click)="errorPage = errorPage + 1; progressFor(file.id)"
                >
                  More errors
                </button>
              }
            }
          }
        </section>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      h1 {
        font-size: 1.6rem;
        font-weight: 650;
      }
      h2 {
        font-size: 1.15rem;
        font-weight: 600;
        margin: 0.5rem 0;
      }
      h3 {
        font-weight: 600;
        margin: 0.75rem 0;
      }
      .columns {
        display: grid;
        grid-template-columns: minmax(16rem, 1fr) minmax(0, 2fr);
        gap: 1rem;
      }
      section {
        border: 1px solid var(--kestrel-border);
        border-radius: 0.5rem;
        padding: 1rem;
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 0.65rem;
        align-items: end;
        margin-block: 0.65rem;
      }
      label {
        display: grid;
        gap: 0.25rem;
      }
      label.check {
        display: flex;
        align-items: center;
      }
      .table-wrap {
        overflow: auto;
      }
      td,
      th {
        padding: 0.4rem;
        text-align: left;
      }
      [role='alert'] {
        color: var(--kestrel-danger);
      }
      @media (max-width: 950px) {
        .columns {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class ImportPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(InventoryApi);
  readonly types = IMPORT_TYPES;
  readonly names = labels;
  readonly preview = signal<Preview | null>(null);
  readonly uploads = signal<Upload[]>([]);
  readonly run = signal<Run | null>(null);
  readonly errors = signal<{ row_number: number; message: string }[]>([]);
  readonly errorTotal = signal(0);
  readonly error = signal('');
  readonly message = signal('');
  readonly busy = signal(false);
  readonly total = signal(0);
  readonly deleting = signal<number | null>(null);
  private timer?: ReturnType<typeof setTimeout>;
  private active?: number;
  private revision = 0;
  page = 1;
  errorPage = 1;
  files: File[] = [];
  type: ImportType = 'asset';
  mapping: Record<string, string | null> = {};
  updateExisting = false;
  preserveBlanks = false;
  sendWelcome = false;

  ngOnInit() {
    void this.load();
  }
  ngOnDestroy() {
    clearTimeout(this.timer);
    this.active = undefined;
  }
  locked() {
    return ['queued', 'running', 'complete'].includes(this.run()?.state ?? '');
  }
  mappingLocked() {
    return this.locked() || (this.run()?.processed ?? 0) > 0;
  }
  choose(event: Event) {
    this.files = Array.from((event.target as HTMLInputElement).files ?? []);
  }
  title(field: string) {
    return field.replace(/^custom:/, 'Custom: ').replaceAll('_', ' ');
  }

  async load() {
    try {
      const result = await this.api.read<{ rows: Upload[]; total: number }>('/imports', {
        page: this.page,
        limit: 20,
      });
      this.uploads.set(result.rows);
      this.total.set(result.total);
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  async upload() {
    const body = new FormData();
    for (const file of this.files) body.append('file', file);
    this.busy.set(true);
    this.error.set('');
    try {
      const result = await this.api.write<Upload[]>('POST', '/imports', body);
      this.files = [];
      this.message.set('CSV uploaded');
      await this.load();
      if (result.payload?.[0]) await this.open(result.payload[0]);
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.busy.set(false);
    }
  }

  async open(file: Upload) {
    clearTimeout(this.timer);
    this.active = file.id;
    this.type = file.import_type ?? 'asset';
    this.run.set(null);
    this.updateExisting = false;
    this.preserveBlanks = false;
    this.sendWelcome = false;
    this.errors.set([]);
    this.errorPage = 1;
    await this.loadMapping(file.id);
    await this.progressFor(file.id);
  }

  async loadMapping(id: number) {
    const revision = ++this.revision;
    try {
      const response = await this.api.read<StandardApiResponse<Preview>>(`/imports/${id}`, {
        import_type: this.type,
      });
      if (revision !== this.revision) return;
      const preview = response.payload;
      if (!preview) return;
      this.preview.set(preview);
      this.mapping =
        preview.import_type === this.type && preview.field_map
          ? { ...preview.field_map }
          : { ...preview.suggested_map };
    } catch (error) {
      if (revision === this.revision) this.error.set(inventoryError(error));
    }
  }

  async process(id: number) {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.write('POST', `/imports/process/${id}`, {
        import_type: this.type,
        field_map: this.mapping,
        update_existing: this.updateExisting,
        preserve_blanks: this.preserveBlanks,
        send_welcome: this.sendWelcome,
      });
      await this.progressFor(id);
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.busy.set(false);
    }
  }

  async progressFor(id: number) {
    clearTimeout(this.timer);
    try {
      const result = await this.api.read<{
        run: Run | null;
        rows: { row_number: number; message: string }[];
        total: number;
      }>(`/imports/${id}/progress`, { page: this.errorPage, limit: 20 });
      if (this.active !== id) return;
      const previous = this.run()?.state;
      this.run.set(result.run);
      if (result.run && !previous) {
        this.updateExisting = result.run.update_existing ?? false;
        this.preserveBlanks = result.run.preserve_blanks ?? false;
        this.sendWelcome = result.run.send_welcome ?? false;
      }
      this.errors.set(result.rows);
      this.errorTotal.set(result.total);
      if (result.run?.state === 'running' || result.run?.state === 'queued')
        this.timer = setTimeout(() => void this.progressFor(id), 1000);
      else if (previous === 'running' || previous === 'queued') await this.load();
    } catch (error) {
      if (this.active === id) this.error.set(inventoryError(error));
    }
  }

  async download(file: Upload) {
    try {
      saveDownload(await this.api.blob(`/imports/${file.id}/download`), file.name);
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  async remove(file: Upload) {
    try {
      await this.api.write('DELETE', `/imports/${file.id}`);
      if (this.active === file.id) {
        clearTimeout(this.timer);
        this.active = undefined;
        this.preview.set(null);
      }
      this.deleting.set(null);
      await this.load();
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }
}

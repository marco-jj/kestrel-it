import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { LabelLayoutSchema, type LabelLayout, type StandardApiResponse } from '@kestrel-it/shared';
import { InventoryApi, inventoryError } from './inventory-api.js';
import { saveDownload } from './inventory-files.component.js';

interface Template {
  id?: number;
  name: string;
  layout: LabelLayout;
  is_default?: boolean;
}
type SizeField =
  | 'width'
  | 'height'
  | 'page_width'
  | 'page_height'
  | 'margin_x'
  | 'margin_y'
  | 'gap_x'
  | 'gap_y'
  | 'font_size'
  | 'skipped';
const defaults = () =>
  LabelLayoutSchema.parse({
    width: 2.625,
    height: 1,
    page_width: 8.5,
    page_height: 11,
    margin_x: 0.19,
    margin_y: 0.5,
    gap_x: 0.125,
  });

@Component({
  selector: 'kestrel-labels-settings',
  imports: [FormsModule],
  template: `
    <h1>Label designer</h1>
    <div class="toolbar">
      <label
        >Template
        <select [ngModel]="selected" (ngModelChange)="choose($event)">
          <option value="">New custom template</option>
          @for (template of templates(); track template.name) {
            <option [value]="template.name">{{ template.name }}</option>
          }
        </select></label
      >
      <label>Template name <input [(ngModel)]="name" maxlength="100" /></label>
      <label class="check"
        ><input [(ngModel)]="isDefault" type="checkbox" /> Default print template</label
      >
    </div>
    <section class="designer">
      <div>
        <div class="fields">
          <label
            >Layout
            <select [(ngModel)]="layout.type">
              <option value="sheet">Sheet</option>
              <option value="roll">Roll</option>
            </select></label
          >
          <label
            >Units
            <select [(ngModel)]="layout.units">
              <option value="in">Inches</option>
              <option value="mm">Millimeters</option>
            </select></label
          >
          @for (field of measurements; track field.key) {
            <label
              >{{ field.label }}
              <input
                type="number"
                [step]="field.key === 'skipped' ? 1 : 0.01"
                [(ngModel)]="layout[field.key]"
            /></label>
          }
          <label>Title <input [(ngModel)]="layout.title" maxlength="80" /></label>
          <label
            >Barcode
            <select [(ngModel)]="layout.barcode">
              @for (format of barcodeFormats; track format) {
                <option [value]="format">{{ format }}</option>
              }
            </select></label
          >
          <label
            >2D code
            <select [(ngModel)]="layout.code2d">
              @for (format of codeFormats; track format) {
                <option [value]="format">{{ format }}</option>
              }
            </select></label
          >
          <label>2D URL prefix <input [(ngModel)]="layout.prefix" maxlength="255" /></label>
          <label
            >2D target
            <select [(ngModel)]="layout.target">
              <option value="hardware_id">Asset ID</option>
              <option value="asset_tag">Asset tag</option>
            </select></label
          >
        </div>
        <fieldset>
          <legend>Printed fields</legend>
          <div class="checks">
            @for (field of fields(); track field.key) {
              <label class="check"
                ><input
                  type="checkbox"
                  [checked]="layout.fields.includes(field.key)"
                  (change)="toggle(field.key)"
                />
                {{ field.label }}</label
              >
            }
          </div>
        </fieldset>
        <div class="toolbar">
          <button class="k-btn k-btn-secondary" (click)="preview()">Preview label</button>
          <button class="k-btn k-btn-primary" [disabled]="!name.trim()" (click)="save()">
            Save label template
          </button>
          @if (id) {
            <button class="k-btn k-btn-secondary" (click)="remove()">Delete template</button>
          }
        </div>
      </div>
      @if (previewUrl(); as url) {
        <div>
          <iframe title="Label preview" [src]="url"></iframe>
          <button class="k-btn k-btn-secondary" (click)="download()">Download preview PDF</button>
        </div>
      }
    </section>
    @if (error()) {
      <p role="alert">{{ error() }}</p>
    }
    @if (message()) {
      <p role="status">{{ message() }}</p>
    }
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
      .designer {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 1rem;
      }
      .toolbar,
      .checks,
      .fields {
        display: flex;
        flex-wrap: wrap;
        gap: 0.7rem;
        align-items: end;
        margin-block: 0.75rem;
      }
      label {
        display: grid;
        gap: 0.25rem;
      }
      .check {
        display: flex;
        align-items: center;
        gap: 0.35rem;
      }
      .fields input[type='number'] {
        width: 8rem;
      }
      iframe {
        border: 1px solid var(--kestrel-border);
        width: 100%;
        height: 32rem;
      }
      [role='alert'] {
        color: var(--kestrel-danger);
      }
      @media (max-width: 950px) {
        .designer {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class LabelsSettingsComponent implements OnInit, OnDestroy {
  private readonly api = inject(InventoryApi);
  private readonly sanitizer = inject(DomSanitizer);
  readonly templates = signal<Template[]>([]);
  readonly message = signal('');
  readonly error = signal('');
  readonly previewUrl = signal<SafeResourceUrl | null>(null);
  readonly fields = signal(
    [
      'asset_tag',
      'name',
      'serial',
      'model',
      'model_number',
      'company',
      'location',
      'purchase_date',
    ].map((key) => ({ key, label: key.replaceAll('_', ' ') })),
  );
  readonly barcodeFormats = ['none', 'C128', 'C39', 'EAN13', 'UPCA', 'ITF'];
  readonly codeFormats = ['none', 'QRCODE', 'DATAMATRIX', 'PDF417'];
  readonly measurements: { key: SizeField; label: string }[] = [
    { key: 'width', label: 'Label width' },
    { key: 'height', label: 'Label height' },
    { key: 'page_width', label: 'Page width' },
    { key: 'page_height', label: 'Page height' },
    { key: 'margin_x', label: 'Side margin' },
    { key: 'margin_y', label: 'Top margin' },
    { key: 'gap_x', label: 'Column gap' },
    { key: 'gap_y', label: 'Row gap' },
    { key: 'font_size', label: 'Font size' },
    { key: 'skipped', label: 'Skip initial labels' },
  ];
  selected = '';
  name = '';
  id?: number;
  isDefault = false;
  layout = defaults();
  private objectUrl?: string;
  private pdf?: Blob;

  ngOnInit() {
    void this.load();
    void this.api
      .records('/fields', { limit: 100 })
      .then((result) =>
        this.fields.update((fields) => [
          ...fields,
          ...result.rows
            .filter((field) => typeof field['db_column'] === 'string')
            .map((field) => ({ key: String(field['db_column']), label: String(field['name']) })),
        ]),
      )
      .catch(() => undefined);
  }

  ngOnDestroy() {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }

  async load() {
    try {
      this.templates.set(
        (await this.api.read<StandardApiResponse<Template[]>>('/labels')).payload ?? [],
      );
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  choose(name: string) {
    this.selected = name;
    const template = this.templates().find((entry) => entry.name === name);
    this.id = template?.id;
    this.name = template?.id ? template.name : name ? name + ' custom' : '';
    this.layout = template
      ? { ...template.layout, fields: [...template.layout.fields] }
      : defaults();
    this.isDefault = template?.is_default ?? false;
  }

  toggle(key: string) {
    this.layout.fields = this.layout.fields.includes(key)
      ? this.layout.fields.filter((value) => value !== key)
      : [...this.layout.fields, key];
  }

  async preview() {
    this.error.set('');
    const layout = LabelLayoutSchema.safeParse(this.layout);
    if (!layout.success) {
      this.error.set('Enter valid label dimensions and settings.');
      return;
    }
    try {
      this.pdf = await this.api.postBlob('/labels/preview', layout.data);
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = URL.createObjectURL(this.pdf);
      this.previewUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(this.objectUrl));
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  download() {
    if (this.pdf) saveDownload(this.pdf, 'label-preview.pdf');
  }

  async save() {
    this.error.set('');
    try {
      const result = await this.api.write<Template>(
        this.id ? 'PATCH' : 'POST',
        this.id ? `/labels/${this.id}` : '/labels',
        { name: this.name, layout: this.layout, is_default: this.isDefault },
      );
      await this.load();
      if (result.payload) this.choose(result.payload.name);
      this.message.set('Label template saved');
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  async remove() {
    if (!this.id) return;
    try {
      await this.api.write('DELETE', `/labels/${this.id}`);
      await this.load();
      this.choose('');
      this.message.set('Label template deleted');
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }
}

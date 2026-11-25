import { Component, OnInit, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { CUSTOM_FIELD_ELEMENTS, type InventoryCustomField } from '@kestrel-it/shared';
import { AuthStore } from '../../core/auth/auth.store.js';
import {
  KestrelDataGridComponent,
  type DataGridActionType,
  type DataGridRow,
} from '../../shared/ui/data-grid.component.js';
import { KestrelSlideDrawerComponent } from '../../shared/ui/slide-drawer.component.js';
import {
  KestrelAsyncSelectComponent,
  type AsyncSelectOption,
} from '../../shared/ui/async-select.component.js';
import { InventoryApi, inventoryError } from './inventory-api.js';
import { field, type InventoryField } from './directory-ui.js';
import { InventoryFormFieldsComponent } from './inventory-form-fields.component.js';

const name: InventoryField = { key: 'name', label: 'Name', required: true };
const fieldProperties: InventoryField[] = [
  name,
  {
    key: 'element',
    label: 'Element',
    type: 'enum',
    options: CUSTOM_FIELD_ELEMENTS,
    required: true,
  },
  field('format', 'Validation format or regex:/…/'),
  field('field_values', 'Options (one per line)', 'textarea'),
  field('help_text', 'Help text', 'textarea'),
  field('field_encrypted', 'Encrypt value', 'boolean'),
  field('is_unique', 'Unique value', 'boolean'),
  field('auto_add_to_fieldsets', 'Add to new fieldsets', 'boolean'),
  field('show_in_listview', 'Show in asset list', 'boolean'),
  field('show_in_email', 'Show in email', 'boolean'),
  field('show_in_requestable_list', 'Show in requestable inventory', 'boolean'),
  field('display_in_user_view', 'Show to assignee', 'boolean'),
  field('display_checkout', 'Show on checkout', 'boolean'),
  field('display_checkin', 'Show on check-in', 'boolean'),
  field('display_audit', 'Show on audit', 'boolean'),
];

@Component({
  selector: 'kestrel-custom-fields-page',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    KestrelDataGridComponent,
    KestrelSlideDrawerComponent,
    KestrelAsyncSelectComponent,
    InventoryFormFieldsComponent,
  ],
  template: `
    <header>
      <h1>{{ isField ? 'Custom Fields' : 'Fieldsets' }}</h1>
      <a class="k-btn k-btn-secondary" [routerLink]="isField ? '/fieldsets' : '/fields'">
        {{ isField ? 'Fieldsets' : 'Custom fields' }}
      </a>
    </header>
    @if (error() && !drawer()) {
      <p role="alert">{{ error() }}</p>
    }
    <kestrel-data-grid
      [columns]="columns"
      [rows]="rows()"
      [total]="total()"
      [page]="page()"
      [creatable]="can('create')"
      [selectable]="false"
      [loading]="loading()"
      (createClicked)="open()"
      (rowAction)="act($event)"
      (searchChanged)="search = $event; page.set(1); load()"
      (pageChanged)="page.set($event); load()"
    />
    <kestrel-slide-drawer [open]="drawer()" [title]="drawerTitle()"
      [placement]="deleting() ? 'center' : 'side'" (closed)="drawer.set(false)">
      @if (drawer()) {
        @if (deleting()) {
          <p>Delete this {{ isField ? 'custom field' : 'fieldset' }}?</p>
        } @else {
          <form [formGroup]="form()" (ngSubmit)="save()">
            <kestrel-inventory-form-fields [form]="form()" [fields]="fields" />
          </form>
          @if (!isField && id()) {
            <h2>Attached fields</h2>
            <ol>
              @for (item of entries(); track item.id; let index = $index) {
                <li>
                  {{ item.name }}
                  <label
                    ><input
                      type="checkbox"
                      [checked]="item.required"
                      (change)="changeRequired(item, $any($event.target).checked)"
                    />
                    Required</label
                  >
                  <button
                    type="button"
                    [disabled]="index === 0"
                    (click)="move(index, -1)"
                    [attr.aria-label]="'Move ' + item.name + ' up'"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    [disabled]="index === entries().length - 1"
                    (click)="move(index, 1)"
                    [attr.aria-label]="'Move ' + item.name + ' down'"
                  >
                    ↓
                  </button>
                  <button type="button" (click)="detach(item)">Remove</button>
                </li>
              } @empty {
                <li>No fields attached</li>
              }
            </ol>
            <kestrel-async-select
              label="Attach a custom field"
              [options]="options()"
              [allowQuickCreate]="false"
              (searchChanged)="loadOptions($event)"
              (selectionChanged)="attach($event)"
            />
          }
        }
        @if (error()) {
          <p role="alert">{{ error() }}</p>
        }
        <div class="actions">
          <button class="k-btn k-btn-secondary" type="button" (click)="drawer.set(false)">
            Cancel
          </button>
          <button [class]="deleting() ? 'k-btn k-btn-danger' : 'k-btn k-btn-primary'"
            type="button" [disabled]="saving()" (click)="save()">
            {{ deleting() ? 'Delete' : 'Save' }}
          </button>
        </div>
      }
    </kestrel-slide-drawer>
  `,
  styles: [
    `
      header,
      .actions {
        display: flex;
        justify-content: space-between;
        gap: 0.75rem;
        margin-block: 0.5rem 1rem;
      }
      h1 {
        font-size: 1.6rem;
        font-weight: 640;
      }
      h2 {
        margin-top: 1.2rem;
        font-weight: 600;
      }
      li {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.6rem;
        margin-block: 0.4rem;
      }
      li button {
        text-decoration: underline;
      }
      .actions {
        justify-content: flex-end;
        margin-top: 1rem;
      }
      [role='alert'] {
        color: var(--kestrel-danger);
      }
    `,
  ],
})
export class CustomFieldsPageComponent implements OnInit {
  private readonly api = inject(InventoryApi);
  private readonly auth = inject(AuthStore);
  readonly isField = inject(ActivatedRoute).snapshot.routeConfig?.path === 'fields';
  readonly path = this.isField ? '/fields' : '/fieldsets';
  readonly fields = this.isField ? fieldProperties : [name];
  readonly columns = this.isField
    ? [
        { key: 'name', label: 'Name' },
        { key: 'element', label: 'Element', sortable: false },
        { key: 'format', label: 'Validation', sortable: false },
      ]
    : [{ key: 'name', label: 'Name' }];
  readonly rows = signal<DataGridRow[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly drawer = signal(false);
  readonly drawerTitle = signal('');
  readonly deleting = signal(false);
  readonly id = signal<number | null>(null);
  readonly entries = signal<InventoryCustomField[]>([]);
  readonly options = signal<AsyncSelectOption[]>([]);
  readonly form = signal(new FormGroup<Record<string, FormControl>>({}));
  search = '';
  private request = 0;

  ngOnInit(): void {
    void this.load();
  }

  can(action: 'create' | 'edit' | 'delete') {
    return this.auth.currentUser()?.isAdmin === true || this.auth.can(`customfields.${action}`);
  }

  async load() {
    const request = ++this.request;
    this.loading.set(true);
    try {
      const data = await this.api.records(this.path, {
        page: this.page(),
        limit: 20,
        search: this.search,
      });
      if (request !== this.request) return;
      this.rows.set(data.rows);
      this.total.set(data.total);
    } catch (error) {
      if (request === this.request) this.error.set(inventoryError(error));
    } finally {
      if (request === this.request) this.loading.set(false);
    }
  }

  async open(id?: number) {
    this.error.set('');
    this.deleting.set(false);
    this.id.set(id ?? null);
    try {
      const data =
        id === undefined ? {} : await this.api.read<Record<string, unknown>>(`${this.path}/${id}`);
      this.entries.set(
        Array.isArray(data['fields']) ? (data['fields'] as InventoryCustomField[]) : [],
      );
      this.form.set(
        new FormGroup(
          Object.fromEntries(
            this.fields.map((field) => [
              field.key,
              new FormControl(
                data[field.key] ?? (field.type === 'boolean' ? false : null),
                field.required ? [Validators.required] : [],
              ),
            ]),
          ),
        ),
      );
      this.drawerTitle.set(id === undefined ? 'Create record' : 'Edit record');
      this.drawer.set(true);
      if (!this.isField && id !== undefined) void this.loadOptions('');
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  act(event: { action: DataGridActionType; row: DataGridRow }) {
    if (typeof event.row.id !== 'number') return;
    if (event.action === 'update') void this.open(event.row.id);
    if (event.action === 'delete') {
      this.error.set('');
      this.id.set(event.row.id);
      this.deleting.set(true);
      this.drawerTitle.set('Delete record');
      this.drawer.set(true);
    }
  }

  async save() {
    if (this.saving()) return;
    if (!this.deleting() && this.form().invalid) {
      this.error.set('Enter the required values.');
      return;
    }
    const id = this.id();
    this.error.set('');
    this.saving.set(true);
    try {
      if (this.deleting()) await this.api.write('DELETE', `${this.path}/${id}`);
      else {
        const input = this.form().getRawValue();
        await this.api.write(
          id === null ? 'POST' : 'PATCH',
          id === null ? this.path : `${this.path}/${id}`,
          input,
        );
      }
      this.drawer.set(false);
      await this.load();
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.saving.set(false);
    }
  }

  async loadOptions(search: string) {
    try {
      const data = await this.api.options('fields', search);
      this.options.set(data.results.map(({ id, text }) => ({ id, text })));
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  async attach(option: AsyncSelectOption | null) {
    if (typeof option?.id !== 'number' || this.entries().some((item) => item.id === option.id))
      return;
    await this.changeEntries(`/fieldsets/${this.id()}/fields`, { field_id: option.id });
  }

  changeRequired(field: InventoryCustomField, required: boolean) {
    return this.changeEntries(`/fieldsets/${this.id()}/fields`, { field_id: field.id, required });
  }

  detach(field: InventoryCustomField) {
    return this.changeEntries(`/fields/${field.id}/disassociate`, { fieldset_id: this.id() });
  }

  async move(index: number, by: number) {
    const ordered = [...this.entries()];
    const next = index + by;
    if (next < 0 || next >= ordered.length) return;
    [ordered[next], ordered[index]] = [ordered[index]!, ordered[next]!];
    await this.changeEntries(`/fields/fieldsets/${this.id()}/order`, {
      field_ids: ordered.map((item) => item.id),
    });
  }

  private async changeEntries(path: string, input: object) {
    if (this.saving() || this.id() === null) return;
    this.saving.set(true);
    this.error.set('');
    try {
      await this.api.write('POST', path, input);
      const data = await this.api.read<{ fields: InventoryCustomField[] }>(
        `${this.path}/${this.id()}`,
      );
      this.entries.set(data.fields);
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.saving.set(false);
    }
  }
}

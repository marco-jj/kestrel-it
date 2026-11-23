import type { PermissionKey } from '@kestrel-it/shared';
import { InventoryFilesComponent } from './inventory-files.component.js';
import { Component, OnInit, inject, signal, viewChild } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import type { CoreInventoryResource } from '@kestrel-it/shared';
import { AuthStore } from '../../core/auth/auth.store.js';
import {
  KestrelDataGridComponent,
  type DataGridActionType,
  type DataGridColumn,
  type DataGridRow,
} from '../../shared/ui/data-grid.component.js';
import { KestrelSlideDrawerComponent } from '../../shared/ui/slide-drawer.component.js';
import { DIRECTORY_UI, permissionFor, type InventoryField } from './directory-ui.js';
import { InventoryApi, inventoryError } from './inventory-api.js';
import { InventoryFormFieldsComponent } from './inventory-form-fields.component.js';

@Component({
  selector: 'kestrel-directory-page',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    KestrelDataGridComponent,
    KestrelSlideDrawerComponent,
    InventoryFormFieldsComponent,
    InventoryFilesComponent,
  ],
  template: `
    <header class="directory-header">
      <h1>{{ definition.title }}</h1>
      @if (can('delete') && resource !== 'groups') {
        <button class="k-btn k-btn-secondary" type="button" (click)="toggleDeleted()">
          {{ deleted() ? 'Show active records' : 'Show deleted records' }}
        </button>
      }
    </header>
    @if (error() && !drawer()) {
      <p role="alert">{{ error() }}</p>
    }
    @if (message()) {
      <p role="status">{{ message() }}</p>
    }
    <kestrel-data-grid
      [columns]="columns"
      [rows]="rows()"
      [total]="total()"
      [page]="page()"
      [creatable]="can('create') && !deleted()"
      [selectable]="can('delete') || (!deleted() && can('edit'))"
      [bulkEdit]="!deleted() && can('edit')"
      [bulkDelete]="!deleted() && can('delete')"
      [bulkRestore]="deleted() && can('delete')"
      [loading]="loading()"
      (createClicked)="open()"
      (rowAction)="act($event)"
      (searchChanged)="searchChanged($event)"
      (sortChanged)="sort = $event.sort; order = $event.order; reload()"
      (pageChanged)="page.set($event); reload()"
      (bulkAction)="bulk($event)"
    />
    <kestrel-slide-drawer [open]="fileRecord() !== null" title="Files" (closed)="fileRecord.set(null)">
      @if (fileRecord(); as itemId) {
        <kestrel-inventory-files [resource]="resource" [itemId]="itemId" [canWrite]="true" />
      }
    </kestrel-slide-drawer>
    <kestrel-slide-drawer [open]="drawer()" [title]="drawerTitle()" (closed)="drawer.set(false)">
      @if (drawer()) {
        @if (pendingAction()) {
          <p>
            Apply this change to {{ selectedIds().length }}
            {{ selectedIds().length === 1 ? 'record' : 'records' }}?
          </p>
        } @else {
          @if (isDelegatedUserCreation()) {
            <p>This user can receive equipment. A superuser can enable sign-in separately.</p>
          }
          <form [formGroup]="form()" (ngSubmit)="save()">
            <kestrel-inventory-form-fields [form]="form()" [fields]="fields()" />
          </form>
          @if (resource === 'users' && currentUserId() && can('edit')) {
            <button type="button" class="k-btn k-btn-secondary" (click)="sendInventory()">Email current inventory</button>
          }
        }
        @if (error()) {
          <p role="alert">{{ error() }}</p>
        }
        <div class="drawer-actions">
          <button class="k-btn k-btn-secondary" type="button" (click)="drawer.set(false)">
            Cancel
          </button>
          <button class="k-btn k-btn-primary" type="button" [disabled]="saving()" (click)="save()">
            {{
              pendingAction() === 'delete'
                ? 'Delete'
                : pendingAction() === 'restore'
                  ? 'Restore'
                  : 'Save'
            }}
          </button>
        </div>
      }
    </kestrel-slide-drawer>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .directory-header,
      .drawer-actions {
        display: flex;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 0.75rem;
        margin-bottom: 1rem;
      }
      h1 {
        font-size: 1.6rem;
        font-weight: 640;
      }
      .drawer-actions {
        justify-content: flex-end;
        margin-top: 1.25rem;
      }
      [role='alert'] {
        color: var(--kestrel-danger);
        margin-block: 0.75rem;
      }
      [role='status'] {
        margin-block: 0.75rem;
      }
    `,
  ],
})
export class DirectoryPageComponent implements OnInit {
  private readonly api = inject(InventoryApi);
  private readonly auth = inject(AuthStore);
  private readonly grid = viewChild(KestrelDataGridComponent);
  readonly resource = inject(ActivatedRoute).snapshot.data['resource'] as CoreInventoryResource;
  readonly definition = DIRECTORY_UI[this.resource];
  readonly columns: DataGridColumn[] = [
    {
      key: 'display_name',
      label: this.resource === 'locations' ? 'Location' : 'Name',
      sortable: false,
    },
    ...(this.resource === 'users'
      ? [
          { key: 'username', label: 'Username' },
          { key: 'email', label: 'Email' },
        ]
      : []),
    { key: 'notes', label: 'Notes', sortable: false },
  ];
  readonly rows = signal<DataGridRow[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly deleted = signal(false);
  readonly drawer = signal(false);
  readonly drawerTitle = signal('');
  readonly fields = signal<InventoryField[]>([]);
  readonly form = signal(new FormGroup<Record<string, FormControl>>({}));
  readonly selectedIds = signal<number[]>([]);
  readonly pendingAction = signal<'delete' | 'restore' | null>(null);
  readonly error = signal('');
  readonly message = signal('');
  search = '';
  sort = '';
  order: 'asc' | 'desc' = 'asc';
  private request = 0;
  private recordId?: number;
  readonly fileRecord = signal<number|null>(null);
  readonly currentUserId = signal<number|null>(null);

  ngOnInit(): void {
    void this.reload();
  }

  can(action: 'create' | 'edit' | 'delete'): boolean {
    return this.resource === 'groups'
      ? this.auth.currentUser()?.isSuperUser === true
      : this.auth.currentUser()?.isAdmin === true ||
          this.auth.can(permissionFor(this.resource, action));
  }

  searchChanged(search: string): void {
    this.grid()?.clearSelection();
    this.search = search;
    this.page.set(1);
    void this.reload();
  }

  isDelegatedUserCreation(): boolean {
    return (
      this.resource === 'users' &&
      this.recordId === undefined &&
      this.selectedIds().length === 0 &&
      this.auth.currentUser()?.isSuperUser !== true
    );
  }

  toggleDeleted(): void {
    this.grid()?.clearSelection();
    this.deleted.update((value) => !value);
    this.page.set(1);
    void this.reload();
  }

  private canFiles() {
    return ['users','companies','departments','locations','suppliers'].includes(this.resource)
      && this.auth.can(`${this.resource}.files` as PermissionKey);
  }

  async sendInventory() {
    try {
      await this.api.write('POST',`/users/${this.currentUserId()}/email`);
      this.message.set('Inventory email queued');
    } catch (error) { this.error.set(inventoryError(error)); }
  }

  async reload(): Promise<void> {
    const request = ++this.request;
    this.loading.set(true);
    this.error.set('');
    try {
      const page = await this.api.records(`/${this.resource}`, {
        limit: 20,
        page: this.page(),
        search: this.search,
        sort: this.sort,
        order: this.order,
        deleted: this.deleted() ? '1' : '0',
      });
      if (request !== this.request) return;
      this.rows.set(this.canFiles() && !this.deleted() ? page.rows.map((row) => ({
        ...row, available_actions: { ...row.available_actions, files:true },
      })) : page.rows);
      this.total.set(page.total);
    } catch (error) {
      if (request === this.request) this.error.set(inventoryError(error));
    } finally {
      if (request === this.request) this.loading.set(false);
    }
  }

  private toForm(data: Record<string, unknown>, bulk = false): void {
    const superuser = this.auth.currentUser()?.isSuperUser === true;
    const editingUsers = this.resource === 'users' && (bulk || this.recordId !== undefined);
    const fields = this.definition.fields.filter((field) => {
      if (
        !superuser &&
        (field.superuserOnly || (editingUsers && ['username', 'email'].includes(field.key)))
      )
        return false;
      return (
        !bulk || (!field.required && field.type !== 'password' && field.type !== 'permissions')
      );
    });
    const controls: Record<string, FormControl> = {};
    for (const field of fields) {
      const initial =
        field.type === 'boolean'
          ? false
          : field.type === 'ids'
            ? []
            : field.type === 'permissions'
              ? {}
              : null;
      controls[field.key] = new FormControl(
        data[field.key] ?? initial,
        field.required && !bulk ? Validators.required : [],
      );
    }
    this.fields.set(fields);
    this.form.set(new FormGroup(controls));
  }

  async open(id?: number): Promise<void> {
    this.error.set('');
    this.message.set('');
    try {
      const data =
        id === undefined ? {} : await this.api.read<DataGridRow>(`/${this.resource}/${id}`);
      this.recordId = id;
      this.currentUserId.set(id ?? null);
      this.selectedIds.set([]);
      this.pendingAction.set(null);
      this.toForm(data);
      this.drawerTitle.set(id === undefined ? 'Create record' : 'Edit record');
      this.drawer.set(true);
    } catch (error) {
      this.error.set(inventoryError(error));
    }
  }

  act(event: { action: DataGridActionType; row: DataGridRow }): void {
    if (typeof event.row.id !== 'number') return;
    if (event.action === 'files') this.fileRecord.set(event.row.id);
    if (event.action === 'update') void this.open(event.row.id);
    if (event.action === 'delete' || event.action === 'restore')
      this.confirm(event.action, [event.row.id]);
  }

  bulk(event: { action: string; selectedIds: Array<number | string> }): void {
    const ids = event.selectedIds.map(Number);
    if (event.action === 'bulk_delete') {
      this.confirm('delete', ids);
    } else if (event.action === 'bulk_restore') {
      this.confirm('restore', ids);
    } else if (event.action === 'bulk_edit') {
      this.recordId = undefined;
      this.pendingAction.set(null);
      this.selectedIds.set(ids);
      this.error.set('');
      this.toForm({}, true);
      this.drawerTitle.set('Bulk edit');
      this.drawer.set(true);
    }
  }

  private confirm(action: 'delete' | 'restore', ids: number[]) {
    this.selectedIds.set(ids);
    this.pendingAction.set(action);
    this.error.set('');
    this.drawerTitle.set(action === 'delete' ? 'Delete records' : 'Restore records');
    this.drawer.set(true);
  }

  async save(): Promise<void> {
    if (this.saving()) return;
    const action = this.pendingAction();
    const ids = this.selectedIds();
    const creating = !ids.length && this.recordId === undefined;
    const changes = Object.fromEntries(
      Object.entries(this.form().controls)
        .filter(
          ([key, control]) =>
            control.dirty ||
            (creating && this.fields().some((field) => field.key === key && field.required)),
        )
        .map(([key, control]) => [key, control.value === '' ? null : control.value]),
    );
    if (!action && (this.form().invalid || Object.keys(changes).length === 0)) {
      this.error.set('Enter the required values or change a field.');
      return;
    }
    this.saving.set(true);
    this.error.set('');
    try {
      const path = `/${this.resource}`;
      if (action || ids.length) {
        await this.api.write(
          'PATCH',
          `${path}/bulk`,
          action ? { action, ids } : { action: 'edit', ids, changes },
        );
      } else {
        await this.api.write(
          creating ? 'POST' : 'PATCH',
          creating ? path : `${path}/${this.recordId}`,
          changes,
        );
      }
      this.drawer.set(false);
      this.grid()?.clearSelection();
      this.message.set('Changes saved.');
      await this.reload();
    } catch (error) {
      this.error.set(inventoryError(error));
    } finally {
      this.saving.set(false);
    }
  }
}

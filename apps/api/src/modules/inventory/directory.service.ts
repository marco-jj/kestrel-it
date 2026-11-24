import { InventoryMailService } from './inventory-mail.service.js';
import { hasSecondaryAssignments } from './assignment-integrity.js';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ALL_PERMISSIONS,
  CORE_INVENTORY_RESOURCES,
  InventoryBulkSchema,
  type AuthenticatedUserContext,
  type CoreInventoryResource,
  type DatatableQuery,
  type PermissionKey,
  type SelectlistQuery,
} from '@kestrel-it/shared';
import {
  and,
  or,
  sql,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  ne,
  SQL,
} from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import { permitsEntity } from '../../common/guards/permissions.guard.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import * as schema from '../../db/schema/index.js';
import { userEmailMatches } from '../../db/user-email.js';
import { companyWebhookFields, directoryDefinitions } from './directory-definitions.js';
import { FmcsScopeService, type FmcsScope } from './fmcs-scope.service.js';
import {
  contains,
  datatable,
  inventoryWrite,
  pageOffset,
  parse,
  selectlist,
  success,
  type InventoryDatabase,
  type InventoryTransaction,
} from './inventory-queries.js';

type Action = 'view' | 'create' | 'edit' | 'delete';
type Row = Record<string, unknown>;
const permissionKeys = new Set<string>(ALL_PERMISSIONS);

function superuserField(column: string) {
  return column === 'permissions' || Object.hasOwn(companyWebhookFields, column);
}

function columnsOf(table: PgTable): Record<string, AnyPgColumn> {
  return getTableColumns(table);
}

function resourceName(value: string): CoreInventoryResource {
  if (!CORE_INVENTORY_RESOURCES.some((resource) => resource === value)) {
    throw new NotFoundException('Unknown inventory resource');
  }
  return value as CoreInventoryResource;
}

function permitted(
  user: AuthenticatedUserContext,
  resource: CoreInventoryResource,
  action: Action,
) {
  if (resource === 'groups')
    return action === 'view' ? user.isAdmin || user.isSuperUser : user.isSuperUser;
  return permitsEntity(user, `${resource}.${action}` as PermissionKey);
}

function requireAction(
  user: AuthenticatedUserContext,
  resource: CoreInventoryResource,
  action: Action,
) {
  if (!permitted(user, resource, action)) throw new ForbiddenException('Insufficient permissions');
}

const deletionReferences: Partial<Record<CoreInventoryResource, [PgTable, string][]>> = {
  companies: [
    [schema.companies, 'parentId'],
    [schema.companyUser, 'companyId'],
    [schema.locations, 'companyId'],
    [schema.departments, 'companyId'],
    [schema.orders, 'companyId'],
    [schema.assets, 'companyId'],
    [schema.licenses, 'companyId'],
    [schema.accessories, 'companyId'],
    [schema.consumables, 'companyId'],
    [schema.components, 'companyId'],
  ],
  groups: [[schema.usersGroups, 'groupId']],
  locations: [
    [schema.locations, 'parentId'],
    [schema.assets, 'locationId'],
    [schema.assets, 'rtdLocationId'],
    [schema.users, 'locationId'],
    [schema.departments, 'locationId'],
    [schema.accessories, 'locationId'],
    [schema.consumables, 'locationId'],
    [schema.components, 'locationId'],
  ],
  departments: [[schema.users, 'departmentId']],
  users: [
    [schema.locations, 'managerId'],
    [schema.departments, 'managerId'],
    [schema.users, 'managerId'],
    [schema.licenseSeats, 'assignedTo'],
  ],
  categories: [
    [schema.models, 'categoryId'],
    [schema.licenses, 'categoryId'],
    [schema.accessories, 'categoryId'],
    [schema.consumables, 'categoryId'],
    [schema.components, 'categoryId'],
  ],
  manufacturers: [
    [schema.models, 'manufacturerId'],
    [schema.licenses, 'manufacturerId'],
    [schema.accessories, 'manufacturerId'],
    [schema.consumables, 'manufacturerId'],
    [schema.components, 'manufacturerId'],
  ],
  suppliers: [
    [schema.assets, 'supplierId'],
    [schema.licenses, 'supplierId'],
    [schema.accessories, 'supplierId'],
    [schema.consumables, 'supplierId'],
    [schema.components, 'supplierId'],
  ],
  statuslabels: [[schema.assets, 'statusId']],
};

@Injectable()
export class DirectoryService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(FmcsScopeService) private readonly fmcs: FmcsScopeService,
    @Inject(InventoryMailService) private readonly mail: InventoryMailService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
  ) {}

  private visible(resource: CoreInventoryResource, scope: FmcsScope, deleted = false) {
    const columns = columnsOf(directoryDefinitions[resource].table);
    return and(
      columns.deletedAt
        ? deleted
          ? isNotNull(columns.deletedAt)
          : isNull(columns.deletedAt)
        : undefined,
      this.fmcs.predicate(scope, resource, columns.id!, columns.companyId),
    );
  }

  async reference(
    tx: InventoryDatabase,
    scope: FmcsScope,
    resource: CoreInventoryResource,
    id: number,
  ) {
    const def = directoryDefinitions[resource];
    const columns = columnsOf(def.table);
    const [row] = await tx
      .select()
      .from(def.table)
      .where(and(eq(columns.id!, id), this.visible(resource, scope)))
      .limit(1);
    if (!row) throw new UnprocessableEntityException('The referenced record is unavailable');
    return row;
  }

  async list(
    resourceValue: string,
    query: DatatableQuery & { deleted?: boolean },
    user: AuthenticatedUserContext,
    url: string,
  ) {
    const resource = resourceName(resourceValue);
    requireAction(user, resource, 'view');
    const definition = directoryDefinitions[resource];
    const columns = columnsOf(definition.table);
    if (query.deleted) {
      requireAction(user, resource, 'delete');
      if (!columns.deletedAt) return datatable(0, [], query, url);
    }
    const scope = await this.fmcs.resolve(user);
    const filters = and(
      this.visible(resource, scope, query.deleted),
      query.search ? this.search(resource, columns[definition.nameKey]!, query.search) : undefined,
    );
    const sort =
      query.sort &&
      Object.hasOwn(definition.shape, query.sort) &&
      (user.isSuperUser || !superuserField(query.sort))
        ? Object.values(columns).find((column) => column.name === query.sort)
        : undefined;
    const order = query.order === 'desc' ? desc : asc;
    const [[total], rows] = await Promise.all([
      this.db.select({ value: count() }).from(definition.table).where(filters),
      this.db
        .select()
        .from(definition.table)
        .where(filters)
        .orderBy(order(sort ?? columns[definition.nameKey]!), asc(columns.id!))
        .limit(query.limit)
        .offset(pageOffset(query)),
    ]);
    const labels = await this.labels(this.db, resource, scope, rows);
    return datatable(
      total!.value,
      rows.map((row) => this.serialize(resource, row, user, labels)),
      query,
      url,
    );
  }

  async options(
    resourceValue: string,
    query: SelectlistQuery,
    user: AuthenticatedUserContext,
    targetPicker = false,
  ) {
    const resource = resourceName(resourceValue);
    if (!targetPicker) requireAction(user, resource, 'view');
    const definition = directoryDefinitions[resource];
    const columns = columnsOf(definition.table);
    const scope = await this.fmcs.resolve(user);
    const status =
      resource === 'statuslabels' && query.statusType
        ? this.statusMatch(query.statusType)
        : undefined;
    const filters = and(
      this.visible(resource, scope),
      status,
      query.search ? this.search(resource, columns[definition.nameKey]!, query.search) : undefined,
      this.fmcs.selectionPredicate(scope, resource, columns.companyId, query.companyId),
    );
    const [[total], rows] = await Promise.all([
      this.db.select({ value: count() }).from(definition.table).where(filters),
      this.db
        .select()
        .from(definition.table)
        .where(filters)
        .orderBy(columns[definition.nameKey]!, columns.id!)
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
    ]);
    const labels = await this.labels(this.db, resource, scope, rows);
    return selectlist(
      total!.value,
      rows.map((row) => ({
        id: Number(row.id),
        text: this.label(resource, row, labels),
        image: typeof row.image === 'string' ? row.image : null,
        tag_color:
          typeof (row.tagColor ?? row.color) === 'string'
            ? String(row.tagColor ?? row.color)
            : null,
        disabled:
          resource === 'users' &&
          row.activated !== true &&
          (!targetPicker || row.inventoryOnly !== true),
      })),
      query,
    );
  }

  private search(resource: CoreInventoryResource, name: AnyPgColumn, value: string) {
    if (resource !== 'users') return contains(name, value);
    return or(
      contains(name, value),
      contains(schema.users.displayName, value),
      contains(sql`concat_ws(' ', ${schema.users.firstName}, ${schema.users.lastName})`, value),
    );
  }

  private statusMatch(status: string): SQL {
    switch (status) {
      case 'deployable':
        return eq(schema.statusLabels.deployable, true);
      case 'pending':
        return eq(schema.statusLabels.pending, true);
      case 'archived':
        return eq(schema.statusLabels.archived, true);
      case 'undeployable':
        return and(
          eq(schema.statusLabels.deployable, false),
          eq(schema.statusLabels.pending, false),
          eq(schema.statusLabels.archived, false),
        )!;
      default:
        throw new UnprocessableEntityException('Unknown status type');
    }
  }

  async get(resourceValue: string, id: number, user: AuthenticatedUserContext) {
    const resource = resourceName(resourceValue);
    requireAction(user, resource, 'view');
    const scope = await this.fmcs.resolve(user);
    const row = await this.find(this.db, resource, scope, id);
    const result = this.serialize(
      resource,
      row,
      user,
      await this.labels(this.db, resource, scope, [row]),
    );
    if (resource === 'users') {
      const memberships = await this.db
        .select({ id: schema.companyUser.companyId })
        .from(schema.companyUser)
        .where(eq(schema.companyUser.userId, id));
      result.company_ids = memberships
        .map(({ id: companyId }) => companyId)
        .filter((companyId) => !scope.enabled || scope.companyIds.includes(companyId));
      if (user.isSuperUser) {
        const groups = await this.db
          .select({ id: schema.usersGroups.groupId })
          .from(schema.usersGroups)
          .where(eq(schema.usersGroups.userId, id));
        result.group_ids = groups.map(({ id: groupId }) => groupId);
      }
    }
    return result;
  }

  async create(resourceValue: string, body: unknown, user: AuthenticatedUserContext) {
    const resource = resourceName(resourceValue);
    requireAction(user, resource, 'create');
    return inventoryWrite(this.db, async (tx) => {
      const scope = await this.fmcs.resolve(user, tx);
      const row = await this.saveInTransaction(tx, resource, scope, user, body);
      return success(
        this.serialize(resource, row, user, await this.labels(tx, resource, scope, [row])),
      );
    });
  }

  async update(resourceValue: string, id: number, body: unknown, user: AuthenticatedUserContext) {
    const resource = resourceName(resourceValue);
    requireAction(user, resource, 'edit');
    return inventoryWrite(this.db, async (tx) => {
      const scope = await this.fmcs.resolve(user, tx);
      const row = await this.saveInTransaction(tx, resource, scope, user, body, id);
      return success(
        this.serialize(resource, row, user, await this.labels(tx, resource, scope, [row])),
      );
    });
  }

  async remove(resourceValue: string, id: number, user: AuthenticatedUserContext) {
    return this.bulk(resourceValue, { action: 'delete', ids: [id] }, user);
  }

  async bulk(resourceValue: string, body: unknown, user: AuthenticatedUserContext) {
    const resource = resourceName(resourceValue);
    const dto = parse(InventoryBulkSchema, body);
    requireAction(user, resource, dto.action === 'edit' ? 'edit' : 'delete');
    const ids = [...new Set(dto.ids)];
    return inventoryWrite(this.db, async (tx) => {
      const scope = await this.fmcs.resolve(user, tx);
      for (const id of ids) {
        if (dto.action === 'edit') {
          await this.saveInTransaction(tx, resource, scope, user, dto.changes, id);
        } else {
          await this.changeDeleted(tx, resource, scope, user, id, dto.action);
        }
      }
      return success({ ids });
    });
  }

  private async find(
    db: InventoryDatabase,
    resource: CoreInventoryResource,
    scope: FmcsScope,
    id: number,
    deleted = false,
  ) {
    const table = directoryDefinitions[resource].table;
    const [row] = await db
      .select()
      .from(table)
      .where(and(eq(columnsOf(table).id!, id), this.visible(resource, scope, deleted)))
      .limit(1);
    if (!row) throw new NotFoundException('Inventory record not found');
    return row;
  }

  async saveInTransaction(
    tx: InventoryTransaction,
    resource: CoreInventoryResource,
    scope: FmcsScope,
    user: AuthenticatedUserContext,
    body: unknown,
    id?: number,
    importRecipient = false,
  ) {
    const definition = directoryDefinitions[resource];
    const validator = z.object(definition.shape).strict();
    const input: Row = parse(id === undefined ? validator : validator.partial(), body);
    const existing = id === undefined ? undefined : await this.find(tx, resource, scope, id);
    const columns = columnsOf(definition.table);
    if (
      resource === 'companies' &&
      Object.keys(companyWebhookFields).some((key) => Object.hasOwn(input, key))
    ) {
      if (!user.isSuperUser)
        throw new ForbiddenException('Company webhook changes require a superuser');
      const endpoint =
        'webhook_endpoint' in input ? input.webhook_endpoint : existing?.webhookEndpoint;
      const provider =
        'webhook_selected' in input ? input.webhook_selected : existing?.webhookSelected;
      if (endpoint && !provider)
        throw new UnprocessableEntityException('Select a webhook provider');
    }
    if (resource === 'companies' && scope.enabled && (id === undefined || 'parent_id' in input)) {
      throw new ForbiddenException('Company hierarchy changes require a superuser under FMCS');
    }
    const sendWelcome = resource === 'users' && !existing && input.send_welcome === true;
    delete input.send_welcome;
    if (resource === 'users') {
      if (
        !user.isSuperUser &&
        existing &&
        ['username', 'email'].some(
          (key) => Object.hasOwn(input, key) && input[key] !== existing[key],
        )
      ) {
        throw new ForbiddenException('Username and email changes require a superuser');
      }
      await this.validateUser(tx, input, user, scope, id, existing?.email);
      const start = input.start_date === undefined ? existing?.startDate : input.start_date;
      const end = input.end_date === undefined ? existing?.endDate : input.end_date;
      if (typeof start === 'string' && typeof end === 'string' && start > end) {
        throw new UnprocessableEntityException('End date cannot precede start date');
      }
      if (id !== undefined && Array.isArray(input.company_ids) &&
        await hasSecondaryAssignments(tx, 'user', id)) {
        const current = await tx.select({ id: schema.companyUser.companyId }).from(schema.companyUser)
          .where(eq(schema.companyUser.userId, id));
        const next = new Set(input.company_ids);
        if (current.length !== next.size || current.some((membership) => !next.has(membership.id))) {
          throw new ConflictException('Check in secondary inventory before changing the user company');
        }
      }
      if (!existing && scope.enabled && input.company_ids === undefined) {
        const companyId = this.fmcs.assign(scope, undefined);
        input.company_ids = companyId === null ? [] : [companyId];
        this.validateMembershipScope(scope, input.company_ids as number[]);
      }
    }
    if (columns.companyId && (id === undefined || 'company_id' in input)) {
      input.company_id = this.fmcs.assign(scope, input.company_id as number | null | undefined);
    }
    if (resource === 'locations' && id !== undefined && scope.scopeLocations &&
      'company_id' in input && input.company_id !== existing?.companyId &&
      await hasSecondaryAssignments(tx, 'location', id)) {
      throw new ConflictException('Check in secondary inventory before changing the location company');
    }
    for (const [key, target] of Object.entries(definition.references ?? {})) {
      const targetId = input[key];
      if (typeof targetId !== 'number') continue;
      const row = await this.reference(tx, scope, target, targetId);
      if (key === 'parent_id' || (key === 'manager_id' && resource === 'users')) {
        const column = key === 'parent_id' ? 'parentId' : 'managerId';
        await this.validateHierarchy(tx, resource, id, targetId, row, column);
      }
    }
    if (resource === 'statuslabels') {
      const active = ['deployable', 'pending', 'archived'].filter(
        (key) => (input[key] ?? existing?.[key]) === true,
      );
      if (active.length > 1) throw new UnprocessableEntityException('Select a single status type');
    }
    if (
      input.permissions &&
      Object.keys(input.permissions).some((key) => !permissionKeys.has(key))
    ) {
      throw new UnprocessableEntityException('Unknown permission');
    }

    const values: Row = { updatedAt: new Date() };
    for (const [key, column] of Object.entries(columns)) {
      if (Object.hasOwn(input, column.name)) values[key] = input[column.name];
    }
    if (typeof input.password === 'string')
      values.password = this.crypto.hashPassword(input.password);
    if (resource === 'users' && !existing && (!user.isSuperUser || importRecipient)) values.inventoryOnly = true;
    if (resource === 'users' && input.activated !== undefined) {
      values.inventoryOnly = false;
      values.activatedAt = input.activated === true ? (existing?.activatedAt ?? new Date()) : null;
    }
    const [saved] =
      id === undefined
        ? await tx
            .insert(definition.table)
            .values({ ...values, createdBy: user.id })
            .returning()
        : await tx.update(definition.table).set(values).where(eq(columns.id!, id)).returning();
    if (resource === 'users') await this.saveMemberships(tx, scope, Number(saved!.id), input);
    if (sendWelcome && typeof saved?.email === 'string')
      await this.mail.enqueue(tx,saved.email,'Welcome to Kestrel-IT','Your Kestrel-IT account has been created.','welcome');
    return saved!;
  }

  private async validateUser(
    tx: InventoryTransaction,
    input: Row,
    actor: AuthenticatedUserContext,
    scope: FmcsScope,
    id?: number,
    currentEmail?: unknown,
  ) {
    if (
      !actor.isSuperUser &&
      ['permissions', 'group_ids', 'password', 'activated'].some((key) => Object.hasOwn(input, key))
    ) {
      throw new ForbiddenException('Authentication and role changes require a superuser');
    }
    if (!actor.isSuperUser && id !== undefined) {
      const [target] = await tx
        .select({ permissions: schema.users.permissions })
        .from(schema.users)
        .where(eq(schema.users.id, id));
      const memberships = await tx
        .select({ permissions: schema.groups.permissions })
        .from(schema.usersGroups)
        .innerJoin(schema.groups, eq(schema.groups.id, schema.usersGroups.groupId))
        .where(eq(schema.usersGroups.userId, id));
      if (
        [target?.permissions, ...memberships.map((group) => group.permissions)].some(
          (permissions) => permissions?.admin === 1 || permissions?.superuser === 1,
        )
      ) {
        throw new ForbiddenException('Only superusers can modify administrator accounts');
      }
      if (scope.enabled && Array.isArray(input.company_ids)) {
        const memberships = await tx
          .select({ id: schema.companyUser.companyId })
          .from(schema.companyUser)
          .where(eq(schema.companyUser.userId, id));
        if (memberships.some(({ id: company }) => !scope.companyIds.includes(company))) {
          throw new ForbiddenException('The user has memberships outside your company scope');
        }
      }
    }
    if (id === actor.id && input.activated === false) {
      throw new UnprocessableEntityException('You cannot deactivate your own account');
    }
    if (typeof input.username === 'string') {
      const [duplicate] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(eq(schema.users.username, input.username), isNull(schema.users.deletedAt)))
        .limit(1);
      if (duplicate && duplicate.id !== id)
        throw new ConflictException('Username is already in use');
    }
    const email = typeof input.email === 'string' ? input.email.trim() : '';
    if (email && (id === undefined || input.email !== currentEmail)) {
      const [duplicate] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(
          and(
            id !== undefined ? ne(schema.users.id, id) : undefined,
            isNull(schema.users.deletedAt),
            userEmailMatches(schema.users.email, email),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw new ConflictException({
          status: 'error',
          messages: { email: ['Email is already in use'] },
          payload: null,
        });
      }
    }
    if (Array.isArray(input.company_ids)) this.validateMembershipScope(scope, input.company_ids);
  }

  private validateMembershipScope(scope: FmcsScope, ids: number[]) {
    if (!scope.enabled) return;
    const outside = ids.some((id) => !scope.companyIds.includes(id));
    if (outside || (!scope.floater && scope.companyIds.length > 0 && ids.length === 0)) {
      throw new UnprocessableEntityException('Company memberships are outside your company scope');
    }
  }

  private async saveMemberships(
    tx: InventoryTransaction,
    scope: FmcsScope,
    id: number,
    input: Row,
  ) {
    if (Array.isArray(input.company_ids)) {
      const ids = [...new Set(input.company_ids as number[])];
      for (const companyId of ids) await this.reference(tx, scope, 'companies', companyId);
      await tx.delete(schema.companyUser).where(eq(schema.companyUser.userId, id));
      if (ids.length)
        await tx
          .insert(schema.companyUser)
          .values(ids.map((companyId) => ({ userId: id, companyId })));
    }
    if (Array.isArray(input.group_ids)) {
      const ids = [...new Set(input.group_ids as number[])];
      const rows = ids.length
        ? await tx
            .select({ id: schema.groups.id })
            .from(schema.groups)
            .where(inArray(schema.groups.id, ids))
        : [];
      if (rows.length !== ids.length) throw new UnprocessableEntityException('Unknown group');
      await tx.delete(schema.usersGroups).where(eq(schema.usersGroups.userId, id));
      if (ids.length)
        await tx.insert(schema.usersGroups).values(ids.map((groupId) => ({ userId: id, groupId })));
    }
  }

  private async validateHierarchy(
    tx: InventoryTransaction,
    resource: CoreInventoryResource,
    id: number | undefined,
    targetId: number,
    target: Row,
    key: string,
  ) {
    const { table } = directoryDefinitions[resource];
    const columns = columnsOf(table);
    if (resource === 'companies') {
      if (targetId === id || target.parentId != null)
        throw new UnprocessableEntityException('Companies support one parent level');
      if (id !== undefined) {
        const [child] = await tx
          .select({ id: columns.id! })
          .from(table)
          .where(and(eq(columns.parentId!, id), isNull(columns.deletedAt!)))
          .limit(1);
        if (child) throw new UnprocessableEntityException('A parent company cannot become a child');
      }
      return;
    }
    const visited = new Set(id === undefined ? [] : [id]);
    let currentId: number | null = targetId;
    let row: Row | undefined = target;
    while (currentId !== null) {
      if (visited.has(currentId))
        throw new UnprocessableEntityException('A hierarchy cannot contain cycles');
      visited.add(currentId);
      const parent: unknown = row?.[key];
      currentId = typeof parent === 'number' ? parent : null;
      if (currentId !== null)
        [row] = await tx
          .select()
          .from(table)
          .where(and(eq(columns.id!, currentId), isNull(columns.deletedAt!)))
          .limit(1);
    }
  }

  private async changeDeleted(
    tx: InventoryTransaction,
    resource: CoreInventoryResource,
    scope: FmcsScope,
    user: AuthenticatedUserContext,
    id: number,
    action: 'restore' | 'delete',
  ) {
    const definition = directoryDefinitions[resource];
    const columns = columnsOf(definition.table);
    if (action === 'restore' && !columns.deletedAt)
      throw new UnprocessableEntityException('This resource cannot be restored');
    if (resource === 'users' && id === user.id)
      throw new UnprocessableEntityException('You cannot delete your own account');
    const row = await this.find(tx, resource, scope, id, action === 'restore');
    if (resource === 'users')
      await this.validateUser(
        tx,
        action === 'restore'
          ? { username: row.username, ...(typeof row.email === 'string' ? { email: row.email } : {}) }
          : {},
        user,
        scope,
        id,
      );
    if (action === 'restore') {
      const key = resource === 'users' ? 'managerId' : 'parentId';
      const parentId = row[key];
      if (typeof parentId === 'number') {
        const [parent] = await tx
          .select()
          .from(definition.table)
          .where(and(eq(columns.id!, parentId), isNull(columns.deletedAt!)))
          .limit(1);
        if (parent) await this.validateHierarchy(tx, resource, id, parentId, parent, key);
      }
    }
    if (action === 'delete') {
      for (const [table, key] of deletionReferences[resource] ?? []) {
        const columns = columnsOf(table);
        if (!columns[key]) continue;
        const [reference] = await tx
          .select({ key: columns[key] })
          .from(table)
          .where(
            and(eq(columns[key], id), columns.deletedAt ? isNull(columns.deletedAt) : undefined),
          )
          .limit(1);
        if (reference) throw new ConflictException('This record is still in use');
      }
      if (resource === 'users' || resource === 'locations') {
        const [assigned] = await tx
          .select({ id: schema.assets.id })
          .from(schema.assets)
          .where(
            and(
              eq(schema.assets.assignedTo, id),
              eq(schema.assets.assignedType, resource === 'users' ? 'user' : 'location'),
              isNull(schema.assets.deletedAt),
            ),
          )
          .limit(1);
        if (assigned || await hasSecondaryAssignments(tx, resource === 'users' ? 'user' : 'location', id)) {
          throw new ConflictException('Inventory is still assigned to this record');
        }
      }
    }
    if (columns.deletedAt) {
      await tx
        .update(definition.table)
        .set({ deletedAt: action === 'delete' ? new Date() : null, updatedAt: new Date() })
        .where(eq(columns.id!, id));
    } else {
      await tx.delete(definition.table).where(eq(columns.id!, id));
    }
  }

  private async labels(
    db: InventoryDatabase,
    resource: CoreInventoryResource,
    scope: FmcsScope,
    rows: Row[],
  ) {
    const result = new Map<number, Row>();
    if (resource !== 'locations' && resource !== 'companies') return result;
    const definition = directoryDefinitions[resource];
    const columns = columnsOf(definition.table);
    let pending = rows;
    const seen = new Set<number>();
    const visible = this.fmcs.predicate(scope, resource, columns.id!, columns.companyId);
    // Shared location names provide breadcrumb context without exposing other companies' locations.
    const visibleAncestor =
      resource === 'locations' && visible ? or(visible, isNull(columns.companyId!)) : visible;
    while (pending.length) {
      const ids: number[] = [];
      for (const row of pending) {
        if (typeof row.parentId !== 'number' || seen.has(row.parentId)) continue;
        seen.add(row.parentId);
        ids.push(row.parentId);
      }
      if (ids.length === 0) break;
      pending = await db
        .select({ id: columns.id!, name: columns.name!, parentId: columns.parentId! })
        .from(definition.table)
        .where(and(inArray(columns.id!, ids), isNull(columns.deletedAt!), visibleAncestor));
      for (const row of pending) result.set(Number(row.id), row);
    }
    return result;
  }

  private label(resource: CoreInventoryResource, row: Row, labels: Map<number, Row>) {
    if (resource === 'users')
      return String(
        row.displayName || [row.firstName, row.lastName].filter(Boolean).join(' ') || row.username,
      );
    const names = [String(row.name)];
    const visited = new Set([Number(row.id)]);
    let parentId = row.parentId;
    while (typeof parentId === 'number' && !visited.has(parentId)) {
      const parent = labels.get(parentId);
      if (!parent) break;
      visited.add(parentId);
      names.unshift(String(parent.name));
      parentId = parent.parentId;
    }
    return names.join(' › ');
  }

  private serialize(
    resource: CoreInventoryResource,
    row: Row,
    user: AuthenticatedUserContext,
    labels = new Map<number, Row>(),
  ) {
    const definition = directoryDefinitions[resource];
    const output: Row = { id: row.id, display_name: this.label(resource, row, labels) };
    if (resource === 'users') output.inventory_only = row.inventoryOnly;
    for (const [key, column] of Object.entries(columnsOf(definition.table))) {
      if (key === 'webhookEndpoint') {
        if (user.isSuperUser) output.webhook_configured = Boolean(row[key]);
        continue;
      }
      if (key === 'password' || !Object.hasOwn(definition.shape, column.name)) continue;
      if (!user.isSuperUser && superuserField(column.name)) continue;
      output[column.name] = row[key];
    }
    output.available_actions = row.deletedAt
      ? { restore: permitted(user, resource, 'delete') }
      : {
          update: permitted(user, resource, 'edit'),
          delete:
            permitted(user, resource, 'delete') && (resource !== 'users' || user.id !== row.id),
        };
    return output;
  }
}

import {
  ForbiddenException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AssetCheckoutInputSchema,
  InventoryAssignmentSchema,
  type AuthenticatedUserContext,
  type CoreInventoryResource,
  type ImportType,
  type PermissionKey,
  type SecondaryResource,
} from '@kestrel-it/shared';
import { and, eq, getTableColumns, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import {
  actionLogs,
  assets,
  categories,
  companies,
  customFieldsets,
  departments,
  depreciations,
  groups,
  locations,
  manufacturers,
  models,
  statusLabels,
  suppliers,
  users,
} from '../../db/schema/index.js';
import { AssetCheckoutService } from './asset-checkout.service.js';
import { AssetModelsService } from './asset-models.service.js';
import { DirectoryService } from './directory.service.js';
import { FmcsScopeService, type FmcsScope } from './fmcs-scope.service.js';
import { HardwareService } from './hardware.service.js';
import { dateCell, importFields } from './import-mapping.js';
import { InventoryMailService } from './inventory-mail.service.js';
import { parse, type InventoryTransaction } from './inventory-queries.js';
import { requireInventoryPermission, writeInventoryLog } from './phase-three-queries.js';
import { SecondaryAssignmentsService } from './secondary-assignments.service.js';
import { SecondaryCatalogService, secondaryTables } from './secondary-catalog.service.js';

const definitions = {
  asset: [assets, 'assets'],
  assetHistory: [assets, 'assets'],
  assetModel: [models, 'models'],
  user: [users, 'users'],
  license: [secondaryTables.licenses, 'licenses'],
  accessory: [secondaryTables.accessories, 'accessories'],
  consumable: [secondaryTables.consumables, 'consumables'],
  component: [secondaryTables.components, 'components'],
  location: [locations, 'locations'],
  category: [categories, 'categories'],
  manufacturer: [manufacturers, 'manufacturers'],
  supplier: [suppliers, 'suppliers'],
} as const satisfies Record<ImportType, readonly [PgTable, string]>;

const related = {
  companies,
  locations,
  suppliers,
  categories,
  manufacturers,
  departments,
  users,
  groups,
  statuslabels: statusLabels,
};
const numericFields = new Set(['min_amt', 'qty', 'seats', 'eol', 'warranty_months']);
const booleanFields = new Set([
  'requestable',
  'archived',
  'byod',
  'require_serial',
  'activated',
  'reassignable',
  'maintained',
  'depreciate',
  'require_acceptance',
  'use_default_eula',
  'alert_on_response',
  'checkin_email',
]);
const references = new Set([
  'category',
  'manufacturer',
  'company',
  'supplier',
  'location',
  'rtd_location',
  'status',
  'model',
  'depreciation',
  'fieldset',
  'department',
  'manager',
  'group',
  'parent',
  'assigned_to',
  'assigned_email',
  'checkout_class',
  'checkout_user',
  'checkout_asset',
  'checkout_location',
  'checkout_at',
  'checkout_note',
  'expected_checkin',
  'checkin_at',
  'checkin_note',
]);

type Cells = Record<string, string>;
type Result = 'created' | 'updated' | 'skipped';
type Context = {
  tx: InventoryTransaction;
  scope: FmcsScope;
  actor: AuthenticatedUserContext;
  cells: Cells;
};

function fail(message: string): never {
  throw new UnprocessableEntityException(message);
}
const blank = (value?: string) => value?.trim() ?? '';
const normalized = (value: string) => value.trim().toLowerCase();

@Injectable()
export class ImportRecordsService {
  constructor(
    @Inject(FmcsScopeService) private readonly fmcs: FmcsScopeService,
    @Inject(DirectoryService) private readonly directory: DirectoryService,
    @Inject(AssetModelsService) private readonly models: AssetModelsService,
    @Inject(HardwareService) private readonly hardware: HardwareService,
    @Inject(SecondaryCatalogService) private readonly catalog: SecondaryCatalogService,
    @Inject(SecondaryAssignmentsService) private readonly secondary: SecondaryAssignmentsService,
    @Inject(AssetCheckoutService) private readonly assets: AssetCheckoutService,
    @Inject(InventoryMailService) private readonly mail: InventoryMailService,
  ) {}

  private async unique(ctx: Context, table: PgTable, resource: string, where: SQL | undefined) {
    if (!where) return undefined;
    const columns = getTableColumns(table as PgTable);
    const rows = await ctx.tx
      .select({ id: columns.id! })
      .from(table)
      .where(
        and(
          where,
          columns.deletedAt && isNull(columns.deletedAt),
          this.fmcs.predicate(ctx.scope, resource, columns.id!, columns.companyId),
        ),
      )
      .limit(2);
    if (rows.length > 1) fail('More than one visible record matches this row');
    return rows[0]?.id as number | undefined;
  }

  private same(column: unknown, value: string) {
    return sql`lower(${column}) = ${normalized(value)}`;
  }

  private async relation(
    ctx: Context,
    resource: keyof typeof related,
    value: string,
    attrs: Record<string, unknown> = {},
    create = true,
  ) {
    if (!value) return null;
    const table = related[resource];
    const columns = getTableColumns(table as PgTable);
    const where =
      resource === 'users'
        ? or(this.same(users.username, value), this.same(users.email, value))
        : and(
            this.same(columns.name, value),
            resource === 'categories' && attrs.category_type
              ? eq(
                  categories.categoryType,
                  attrs.category_type as typeof categories.$inferSelect.categoryType,
                )
              : undefined,
          );
    const id = await this.unique(ctx, table, resource, where);
    if (id !== undefined) return id;
    if (!create) fail(`No visible ${resource} record matches the row`);
    requireInventoryPermission(ctx.actor, `${resource}.create` as PermissionKey);
    const record = await this.directory.saveInTransaction(
      ctx.tx,
      resource,
      ctx.scope,
      ctx.actor,
      resource === 'users'
        ? { username: value, ...(value.includes('@') ? { email: value } : {}), ...attrs }
        : { name: value, ...attrs },
      undefined,
      resource === 'users',
    );
    return Number(record.id);
  }

  private async matches(ctx: Context, type: ImportType, companyId?: number | null) {
    const [table, resource] = definitions[type];
    const col = getTableColumns(table as PgTable);
    const c = ctx.cells;
    let where: SQL | undefined;
    if (type === 'asset' || type === 'assetHistory')
      where = c.asset_tag ? this.same(assets.assetTag, c.asset_tag) : undefined;
    else if (type === 'user')
      where = or(
        c.username ? this.same(users.username, c.username) : undefined,
        c.email ? this.same(users.email, c.email) : undefined,
      );
    else if (c.name) {
      const discriminators: Partial<Record<ImportType, string>> = {
        assetModel: 'model_number',
        component: 'serial',
        license: 'serial',
        accessory: 'model_number',
        consumable: 'item_no',
        category: 'category_type',
      };
      const discriminator = discriminators[type];
      const secondaryColumn =
        discriminator &&
        col[discriminator.replace(/_([a-z])/g, (_m, char: string) => char.toUpperCase())];
      const sameName = and(
        this.same(col.name, c.name),
        typeof companyId === 'number' && col.companyId ? eq(col.companyId, companyId) : undefined,
      );
      where = and(
        sameName,
        secondaryColumn && discriminator && c[discriminator]
          ? this.same(secondaryColumn, c[discriminator]!)
          : undefined,
        type === 'license' && !c.serial
          ? or(isNull(secondaryTables.licenses.serial), eq(secondaryTables.licenses.serial, ''))
          : undefined,
      );
      if (
        (type === 'accessory' || type === 'consumable') &&
        secondaryColumn &&
        discriminator &&
        c[discriminator]
      ) {
        const exact = await this.unique(ctx, table, resource, where);
        if (exact !== undefined) return exact;
        where = and(sameName, isNull(secondaryColumn));
      }
    }
    return this.unique(ctx, table, resource, where);
  }

  private async linkedModel(ctx: Context) {
    const c = ctx.cells;
    if (!c.model) return undefined;
    const match = await this.unique(
      ctx,
      models,
      'models',
      and(
        this.same(models.name, c.model),
        c.model_number ? this.same(models.modelNumber, c.model_number) : undefined,
      ),
    );
    if (match !== undefined) return match;
    requireInventoryPermission(ctx.actor, 'models.create');
    const category = await this.relation(ctx, 'categories', c.category || 'Uncategorized', {
      category_type: 'asset',
    });
    const manufacturer = await this.relation(ctx, 'manufacturers', blank(c.manufacturer));
    return (
      await this.models.saveInTransaction(
        ctx.tx,
        {
          name: c.model,
          model_number: c.model_number,
          category_id: category,
          manufacturer_id: manufacturer,
        },
        ctx.actor,
      )
    ).id;
  }

  private async target(ctx: Context, type: ImportType, companyId?: number | null, history = false) {
    const c = ctx.cells;
    if (
      type === 'component' ||
      c.checkout_asset ||
      (type === 'license' && c.asset_tag) ||
      (type !== 'assetHistory' && c.checkout_class?.toLowerCase().includes('asset'))
    ) {
      const tag =
        c.checkout_asset || (type === 'asset' ? c.assigned_to : c.asset_tag || c.assigned_to);
      if (!tag) return;
      const id = await this.unique(ctx, assets, 'assets', this.same(assets.assetTag, tag));
      if (!id) fail('The checkout asset does not exist in scope');
      return { target_type: 'asset' as const, target_id: id };
    }
    const value = c.checkout_location || c.checkout_user || c.assigned_email || c.assigned_to;
    if (!value) return;
    if (c.checkout_location || c.checkout_class?.toLowerCase().includes('location')) {
      const id = await this.relation(
        ctx,
        'locations',
        value,
        companyId ? { company_id: companyId } : {},
        !history,
      );
      return { target_type: 'location' as const, target_id: id! };
    }
    let id = await this.unique(
      ctx,
      users,
      'users',
      or(
        this.same(users.username, value),
        this.same(users.email, value),
        this.same(users.displayName, value),
        this.same(sql`concat_ws(' ', ${users.firstName}, ${users.lastName})`, value),
      ),
    );
    if (!id && !history)
      id = (await this.relation(
        ctx,
        'users',
        value,
        companyId ? { company_ids: [companyId] } : {},
      ))!;
    if (!id) fail('The checkout user does not exist in scope');
    return { target_type: 'user' as const, target_id: id };
  }

  async import(
    tx: InventoryTransaction,
    actor: AuthenticatedUserContext,
    type: ImportType,
    cells: Cells,
    options: { updateExisting: boolean; sendWelcome: boolean },
  ): Promise<Result> {
    requireInventoryPermission(actor, 'import', true);
    if (type === 'license' && 'serial' in cells)
      requireInventoryPermission(actor, 'licenses.keys', true);
    if (type === 'user' && !cells.username && !cells.email) {
      const username = [cells.first_name, cells.last_name].filter(Boolean).join('.').toLowerCase();
      if (username) cells.username = username;
    }
    const scope = await this.fmcs.resolve(actor, tx);
    const ctx = { tx, actor, scope, cells };
    const company = cells.company
      ? await this.relation(ctx, 'companies', cells.company)
      : undefined;
    const current = await this.matches(ctx, type, company);
    if (type === 'assetHistory') return this.history(ctx, current);
    if (current && !options.updateExisting) {
      if (type === 'asset') fail('The asset tag is already in use');
      if (type === 'accessory' || type === 'consumable' || type === 'license') {
        const resource = definitions[type][1];
        const item = await this.catalog.find(tx, resource, scope, current, true);
        await this.assignSecondary(ctx, type, resource, current, item.company_id);
      }
      return 'skipped';
    }
    const [, resource] = definitions[type];
    requireInventoryPermission(
      actor,
      `${resource}.${current ? 'edit' : 'create'}` as PermissionKey,
    );
    const data: Record<string, unknown> = {};
    for (const field of importFields[type]) {
      const value = cells[field];
      if (value === undefined || references.has(field)) continue;
      if (booleanFields.has(field)) {
        if (value && !/^(1|0|true|false|yes|no|y|n)$/i.test(value))
          fail('Invalid boolean in CSV row');
        if (value) data[field] = /^(1|true|yes|y)$/i.test(value);
      } else if (!value) {
        if (!['name', 'qty', 'seats', 'username', 'asset_tag', 'category_type'].includes(field))
          data[field] = null;
      } else if (numericFields.has(field)) data[field] = Number(value);
      else if (field.endsWith('_date')) data[field] = dateCell(value);
      else if (field === 'purchase_cost') data[field] = value.replace(/[$€£,\s]/g, '');
      else if (field === 'category_type') data[field] = normalized(value).replace(/s$/, '');
      else data[field] = value;
    }
    const setRelation = async (
      field: string,
      key: string,
      table: keyof typeof related,
      attrs: Record<string, unknown> = {},
      create = true,
    ) => {
      if (cells[field] !== undefined)
        data[key] = await this.relation(ctx, table, cells[field]!, attrs, create);
    };
    if (company !== undefined || 'company' in cells) {
      if (type === 'user') data.company_ids = company ? [company] : [];
      else data.company_id = company ?? null;
    }
    const categoryType = (
      {
        asset: 'asset',
        assetModel: 'asset',
        license: 'license',
        accessory: 'accessory',
        consumable: 'consumable',
        component: 'component',
      } as const
    )[type as 'asset'];
    if (type !== 'asset' && categoryType)
      await setRelation('category', 'category_id', 'categories', { category_type: categoryType });
    if (type === 'assetModel' && !current && !data.category_id)
      data.category_id = await this.relation(ctx, 'categories', 'Uncategorized', {
        category_type: 'asset',
      });
    if (categoryType && type !== 'asset')
      await setRelation('manufacturer', 'manufacturer_id', 'manufacturers');
    if (
      type === 'asset' ||
      type === 'license' ||
      type === 'accessory' ||
      type === 'consumable' ||
      type === 'component'
    )
      await setRelation(
        'supplier',
        type === 'asset' || type === 'license' ? 'supplier_id' : 'default_supplier_id',
        'suppliers',
      );
    const companyAttrs = company ? { company_id: company } : {};
    await setRelation('location', 'location_id', 'locations', companyAttrs);
    await setRelation('rtd_location', 'rtd_location_id', 'locations', companyAttrs);
    await setRelation('parent', 'parent_id', 'locations', companyAttrs);
    await setRelation('department', 'department_id', 'departments', companyAttrs);
    await setRelation('manager', 'manager_id', 'users', {}, false);
    if ('group' in cells) {
      if (!actor.isSuperUser)
        throw new ForbiddenException('Only superusers can change group membership');
      data.group_ids = cells.group
        ? [await this.relation(ctx, 'groups', cells.group, {}, false)]
        : [];
    }
    if ('depreciation' in cells) {
      data.depreciation_id = cells.depreciation
        ? await this.unique(
            ctx,
            depreciations,
            'depreciations',
            this.same(depreciations.name, cells.depreciation),
          )
        : null;
      if (data.depreciation_id === undefined) fail('Depreciation schedule was not found');
    }
    if ('fieldset' in cells) {
      data.fieldset_id = cells.fieldset
        ? await this.unique(
            ctx,
            customFieldsets,
            'customfields',
            this.same(customFieldsets.name, cells.fieldset),
          )
        : null;
      if (data.fieldset_id === undefined) fail('Custom fieldset was not found');
    }

    if (type === 'asset') {
      if (cells.model) data.model_id = await this.linkedModel(ctx);
      if (cells.status)
        data.status_id = await this.relation(ctx, 'statuslabels', cells.status, {
          deployable: true,
        });
      if (!current && !data.status_id) {
        const [status] = await tx
          .select({ id: statusLabels.id })
          .from(statusLabels)
          .where(isNull(statusLabels.deletedAt))
          .orderBy(sql`${statusLabels.defaultLabel} desc`, statusLabels.id)
          .limit(1);
        if (!status) fail('Choose a status label');
        data.status_id = status.id;
      }
      const custom = Object.entries(cells).filter(([key]) => key.startsWith('custom:'));
      if (custom.length)
        data.custom_fields = Object.fromEntries(
          custom.map(([key, value]) => [key.slice(7), value || null]),
        );
      const row = await this.hardware.saveInTransaction(tx, data, actor, current);
      const target = await this.target(ctx, type, company);
      if (target) {
        const existing = await this.hardware.find(tx, scope, row.id);
        if (
          existing.assignedTo !== target.target_id ||
          existing.assignedType !== target.target_type
        ) {
          const checkout = parse(AssetCheckoutInputSchema, {
            ...target,
            note: cells.checkout_note,
            checkout_at: cells.checkout_at ? this.timestamp(cells.checkout_at) : undefined,
            expected_checkin: cells.expected_checkin ? dateCell(cells.expected_checkin) : undefined,
          });
          await this.assets.checkoutInTransaction(tx, row.id, checkout, actor, scope);
        }
      }
    } else if (type === 'assetModel') {
      await this.models.saveInTransaction(tx, data, actor, current);
    } else if (resource in secondaryTables) {
      const secondary = resource as SecondaryResource;
      const nextQty = current && type !== 'license' ? data.qty : undefined;
      if (nextQty !== undefined) delete data.qty;
      if (type !== 'license') {
        for (const [from, to] of [
          ['purchase_date', 'legacy_purchase_date'],
          ['purchase_cost', 'default_purchase_cost'],
          ['order_number', 'legacy_order_number'],
        ] as const) {
          if (from in data) data[to] = data[from];
          delete data[from];
        }
        delete data.asset_tag;
      } else delete data.asset_tag;
      const row = await this.catalog.saveInTransaction(tx, secondary, scope, actor, data, current);
      const itemId = Number(row.id);
      const item = await this.catalog.find(tx, secondary, scope, itemId, true);
      if (nextQty !== undefined && nextQty !== item.qty) {
        if (typeof nextQty !== 'number' || !Number.isInteger(nextQty) || nextQty < 0)
          fail('Invalid stock quantity');
        const amount = nextQty - item.qty!;
        const acquisition =
          amount > 0 && data.legacy_order_number
            ? {
                order_number: data.legacy_order_number,
                supplier_id: data.default_supplier_id,
                unit_cost: data.default_purchase_cost,
                purchase_date: data.legacy_purchase_date,
              }
            : {};
        await this.secondary.adjustInTransaction(
          tx,
          secondary,
          itemId,
          { amount, ...acquisition, note: cells.checkout_note || 'CSV inventory quantity update' },
          actor,
          'importer',
        );
      }
      if (type !== 'component' || !current)
        await this.assignSecondary(ctx, type, secondary, itemId, item.company_id);
    } else {
      if (type === 'user' && !current && !data.username) {
        data.username =
          cells.email ||
          [cells.first_name, cells.last_name].filter(Boolean).join('.').toLowerCase();
      }
      if (type === 'user' && !actor.isSuperUser) delete data.activated;
      if (type === 'user' && current && !actor.isSuperUser) {
        delete data.username;
        delete data.email;
      }
      const row = await this.directory.saveInTransaction(
        tx,
        resource as CoreInventoryResource,
        scope,
        actor,
        data,
        current,
        type === 'user',
      );
      if (type === 'user' && !current && options.sendWelcome && typeof row.email === 'string')
        await this.mail.enqueue(
          tx,
          row.email,
          'Welcome to Kestrel-IT',
          'Your Kestrel-IT account has been created.',
          'welcome',
        );
    }
    return current ? 'updated' : 'created';
  }

  private async assignSecondary(
    ctx: Context,
    type: ImportType,
    resource: SecondaryResource,
    id: number,
    companyId: number | null,
  ) {
    const target = await this.target(ctx, type, companyId);
    if (!target) return;
    await this.secondary.checkoutInTransaction(
      ctx.tx,
      resource,
      id,
      parse(InventoryAssignmentSchema, {
        ...target,
        note: ctx.cells.checkout_note || 'Checkout from CSV import',
      }),
      ctx.actor,
      ctx.scope,
    );
  }

  private timestamp(value: string) {
    if (value.includes('T')) {
      const timestamp = new Date(value);
      if (!Number.isNaN(timestamp.valueOf())) return timestamp.toISOString();
    }
    return dateCell(value);
  }

  private async history(ctx: Context, id?: number): Promise<Result> {
    requireInventoryPermission(ctx.actor, 'assets.edit');
    if (!id) fail('Asset history requires an existing asset');
    if (!ctx.cells.checkout_at) fail('A historical checkout date is required');
    const target = await this.target(ctx, 'assetHistory', undefined, true);
    if (!target) fail('A historical checkout target is required');
    const asset = await this.hardware.find(ctx.tx, ctx.scope, id);
    const events = [
      {
        type: 'checkout',
        date: this.timestamp(ctx.cells.checkout_at),
        note: ctx.cells.checkout_note,
      },
    ];
    if (ctx.cells.checkin_at) {
      const date = this.timestamp(ctx.cells.checkin_at);
      if (new Date(date).valueOf() < new Date(events[0]!.date).valueOf())
        fail('Check-in precedes checkout');
      events.push({ type: 'checkin from', date, note: ctx.cells.checkin_note });
    }
    let inserted = false;
    for (const event of events) {
      const date = new Date(event.date);
      const [existing] = await ctx.tx
        .select({ id: actionLogs.id })
        .from(actionLogs)
        .where(
          and(
            eq(actionLogs.itemType, 'asset'),
            eq(actionLogs.itemId, id),
            eq(actionLogs.actionType, event.type),
            eq(actionLogs.targetType, target.target_type),
            eq(actionLogs.targetId, target.target_id),
            eq(actionLogs.actionDate, date),
          ),
        )
        .limit(1);
      if (existing) continue;
      await writeInventoryLog(ctx.tx, {
        itemType: 'asset',
        itemId: id,
        actionType: event.type,
        actionDate: date,
        targetType: target.target_type,
        targetId: target.target_id,
        companyId: asset.companyId,
        note: event.note,
        createdBy: ctx.actor.id,
        actionSource: 'importer',
        expectedCheckin: ctx.cells.expected_checkin
          ? dateCell(ctx.cells.expected_checkin)
          : undefined,
      });
      inserted = true;
    }
    return inserted ? 'created' : 'skipped';
  }
}

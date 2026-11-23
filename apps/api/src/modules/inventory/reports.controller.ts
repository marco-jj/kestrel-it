import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  DatatableQuerySchema,
  InventoryIdSchema,
  REPORT_TYPES,
  ReportQuerySchema,
  type AuthenticatedUserContext,
  type PermissionKey,
  type ReportType,
} from '@kestrel-it/shared';
import { and, eq, getTableColumns, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import ExcelJS from 'exceljs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PassThrough, Readable } from 'node:stream';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import { permitsEntity, permitsKey } from '../../common/guards/permissions.guard.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import {
  accessories,
  actionLogs,
  assetMaintenances,
  assets,
  checkoutAcceptances,
  companies,
  components,
  consumables,
  customFields,
  departments,
  depreciations,
  licenses,
  locations,
  models,
  reportTemplates,
  suppliers,
  users,
} from '../../db/schema/index.js';
import { CheckoutAcceptancesService } from './checkout-acceptances.service.js';
import { depreciationValue } from './depreciation.js';
import { FmcsScopeService, type FmcsScope } from './fmcs-scope.service.js';
import { HardwareService } from './hardware.service.js';
import { datatable, pageOffset, parse, success } from './inventory-queries.js';
import { attachmentResponse } from './operational-files.controller.js';
import { currentSettings, requireInventoryPermission } from './phase-three-queries.js';
import { usedStock } from './secondary-catalog.service.js';

type ReportQuery = z.output<typeof ReportQuerySchema>;
type Row = Record<string, unknown>;
type ReportSource = {
  fields: Record<string, unknown>;
  from: SQL;
  where: SQL;
  sort?: string;
  hidden?: string[];
};
const reportType = z.enum(REPORT_TYPES);
const customTypes = z.enum(['custom', 'custom-components', 'custom-consumables']);
const templateInput = z.object({
  name: z.string().trim().min(1).max(255),
  report: customTypes,
  is_shared: z.boolean().default(false),
  options: ReportQuerySchema,
});

export function csvCell(value: unknown) {
  const text =
    value instanceof Date
      ? value.toISOString()
      : value == null
        ? ''
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
  const safe =
    typeof value === 'number'
      ? text
      : /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(text)
        ? "'" + text
        : text;
  return '"' + safe.replaceAll('"', '""') + '"';
}

@Controller()
export class ReportsController {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(FmcsScopeService) private readonly fmcs: FmcsScopeService,
    @Inject(HardwareService) private readonly hardware: HardwareService,
    @Inject(CheckoutAcceptancesService) private readonly acceptances: CheckoutAcceptancesService,
  ) {}

  private access(user: AuthenticatedUserContext, type: ReportType, scoped?: string) {
    const view = permitsKey(user, 'reports.view');
    if (
      type === 'activity' &&
      (scoped === 'true' || !view) &&
      [
        'assets.view',
        'users.view',
        'licenses.view',
        'accessories.view',
        'consumables.view',
        'components.view',
      ].some((permission) => permitsEntity(user, permission as PermissionKey))
    )
      return true;
    if (
      type === 'unaccepted-assets' &&
      !view &&
      ['assets.checkout', 'licenses.checkout', 'accessories.checkout', 'consumables.checkout'].some(
        (permission) => permitsKey(user, permission as PermissionKey),
      )
    )
      return false;
    requireInventoryPermission(user, 'reports.view', true);
    return false;
  }

  private scope(scope: FmcsScope, table: PgTable, name: string) {
    const columns = getTableColumns(table);
    return this.fmcs.predicate(scope, name, columns.id!, columns.companyId) ?? sql`true`;
  }

  private activity(
    scope: FmcsScope,
    user: AuthenticatedUserContext,
    narrow: boolean,
    query: ReportQuery,
  ): ReportSource {
    const date = sql`coalesce(${actionLogs.actionDate}, ${actionLogs.createdAt})`;
    const sources: [string, PgTable, string, PermissionKey][] = [
      ['asset', assets, 'hardware', 'assets.view'],
      ['model', models, 'models', 'models.view'],
      ['license', licenses, 'licenses', 'licenses.view'],
      ['accessory', accessories, 'accessories', 'accessories.view'],
      ['consumable', consumables, 'consumables', 'consumables.view'],
      ['component', components, 'components', 'components.view'],
      ['user', users, 'users', 'users.view'],
      ['company', companies, 'companies', 'companies.view'],
      ['department', departments, 'departments', 'departments.view'],
      ['location', locations, 'locations', 'locations.view'],
      ['supplier', suppliers, 'suppliers', 'suppliers.view'],
      ['maintenance', assetMaintenances, 'maintenances', 'assets.view'],
    ];
    const visible = sources
      .filter(([, , , permission]) => !narrow || permitsEntity(user, permission))
      .map(([type, table, name]) => {
        const { id } = getTableColumns(table);
        const sourceScope =
          type === 'maintenance'
            ? sql`exists (select 1 from ${assets} where ${assets.id} = ${assetMaintenances.itemId} and ${this.scope(scope, assets, 'hardware')})`
            : this.scope(scope, table, name);
        return sql`(${actionLogs.itemType} = ${type} and exists (select 1 from ${table}
        where ${id} = ${actionLogs.itemId} and ${sourceScope}))`;
      });
    const findUser = (column: typeof actionLogs.createdBy | typeof actionLogs.targetId) =>
      permitsEntity(user, 'users.view')
        ? sql`(select ${users.id} from ${users}
        where ${users.id} = ${column} and ${this.scope(scope, users, 'users')})`
        : sql`null`;
    return {
      from: sql`from ${actionLogs}`,
      sort: 'action_date',
      fields: {
        id: actionLogs.id,
        action_date: date,
        action_type: actionLogs.actionType,
        item_type: actionLogs.itemType,
        item_id: actionLogs.itemId,
        company_id: actionLogs.companyId,
        quantity: actionLogs.quantity,
        note: actionLogs.note,
        actor_id: findUser(actionLogs.createdBy),
        target_type: actionLogs.targetType,
        target_id: sql`case when ${actionLogs.targetType} = 'user' then ${findUser(actionLogs.targetId)} end`,
      },
      where:
        and(
          isNull(actionLogs.deletedAt),
          this.scope(scope, actionLogs, 'history'),
          scope.enabled || narrow ? (or(...visible) ?? sql`false`) : undefined,
          query.item_type ? eq(actionLogs.itemType, query.item_type) : undefined,
          query.action_type ? eq(actionLogs.actionType, query.action_type) : undefined,
          query.company_id ? eq(actionLogs.companyId, query.company_id) : undefined,
          query.from ? sql`${date} >= ${query.from}::date` : undefined,
          query.to ? sql`${date} < ${query.to}::date + 1` : undefined,
        ) ?? sql`true`,
    };
  }

  private hardwareSource(
    scope: FmcsScope,
    query: ReportQuery,
    depreciation: boolean,
  ): ReportSource {
    const date = {
      purchase_date: assets.purchaseDate,
      last_checkout: assets.lastCheckout,
      last_checkin: assets.lastCheckin,
      updated_at: assets.updatedAt,
      expiration_date: assets.assetEolDate,
    }[query.date_field ?? 'purchase_date'];
    return {
      from: sql`from ${assets} left join ${models} on ${models.id} = ${assets.modelId}
        left join ${depreciations} on ${depreciations.id} = ${models.depreciationId}
        left join ${companies} on ${companies.id} = ${assets.companyId}
        left join ${locations} on ${locations.id} = ${assets.locationId} and ${this.scope(scope, locations, 'locations')}
        left join ${suppliers} on ${suppliers.id} = ${assets.supplierId}`,
      fields: {
        id: assets.id,
        asset_tag: assets.assetTag,
        name: assets.name,
        serial: assets.serial,
        model: models.name,
        model_number: models.modelNumber,
        company: companies.name,
        location: locations.name,
        supplier: suppliers.name,
        status_id: assets.statusId,
        purchase_date: assets.purchaseDate,
        purchase_cost: assets.purchaseCost,
        order_number: assets.orderNumber,
        warranty_months: assets.warrantyMonths,
        notes: assets.notes,
        last_checkout: assets.lastCheckout,
        last_checkin: assets.lastCheckin,
        expected_checkin: assets.expectedCheckin,
        assigned_type: assets.assignedType,
        ...(depreciation
          ? {
              depreciation: depreciations.name,
              book_value: sql`null`,
              _schedule: sql`to_jsonb(${depreciations})`,
            }
          : {}),
      },
      where: and(
        isNull(assets.deletedAt),
        this.scope(scope, assets, 'hardware'),
        query.company_id ? eq(assets.companyId, query.company_id) : undefined,
        query.supplier_id ? eq(assets.supplierId, query.supplier_id) : undefined,
        query.model_id ? eq(assets.modelId, query.model_id) : undefined,
        query.location_id
          ? and(eq(locations.id, query.location_id), this.scope(scope, locations, 'locations'))
          : undefined,
        query.status_id ? eq(assets.statusId, query.status_id) : undefined,
        query.category_id ? eq(models.categoryId, query.category_id) : undefined,
        query.assigned === 'yes'
          ? sql`${assets.assignedTo} is not null`
          : query.assigned === 'no'
            ? isNull(assets.assignedTo)
            : undefined,
        query.from ? sql`${date} >= ${query.from}::date` : undefined,
        query.to ? sql`${date} < ${query.to}::date + 1` : undefined,
      )!,
      hidden: depreciation ? ['_schedule'] : [],
    };
  }

  private async source(
    type: ReportType,
    query: ReportQuery,
    user: AuthenticatedUserContext,
    scope: FmcsScope,
    narrow: boolean,
  ): Promise<ReportSource> {
    if (type === 'activity') return this.activity(scope, user, narrow, query);
    if (type === 'custom' || type === 'depreciation')
      return this.hardwareSource(scope, query, type === 'depreciation');
    if (type === 'audit') {
      const base = this.activity(scope, user, false, {
        ...query,
        item_type: 'asset',
        action_type: 'audit',
      });
      return {
        ...base,
        from: sql`${base.from} join ${assets} on ${assets.id} = ${actionLogs.itemId}`,
        fields: {
          id: actionLogs.id,
          action_date: base.fields.action_date,
          asset_tag: assets.assetTag,
          name: assets.name,
          actor_id: base.fields.actor_id,
          note: actionLogs.note,
          has_photo: sql`${actionLogs.filename} is not null`,
          next_audit_date: assets.nextAuditDate,
        },
        where: and(base.where, isNull(assets.deletedAt), this.scope(scope, assets, 'hardware'))!,
      };
    }
    if (type === 'maintenances') {
      const table = assetMaintenances;
      return {
        from: sql`from ${table} join ${assets} on ${assets.id} = ${table.itemId}
        left join ${suppliers} on ${suppliers.id} = ${table.supplierId}`,
        fields: {
          id: table.id,
          name: table.name,
          asset_tag: assets.assetTag,
          supplier: suppliers.name,
          maintenance_type: table.assetMaintenanceType,
          is_warranty: table.isWarranty,
          start_date: table.startDate,
          completed_at: table.completedAt,
          cost: table.cost,
          notes: table.notes,
        },
        where: and(
          isNull(table.deletedAt),
          isNull(assets.deletedAt),
          this.scope(scope, assets, 'hardware'),
          query.company_id ? eq(assets.companyId, query.company_id) : undefined,
          query.supplier_id ? eq(table.supplierId, query.supplier_id) : undefined,
          query.from ? sql`${table.startDate} >= ${query.from}::date` : undefined,
          query.to ? sql`${table.startDate} <= ${query.to}::date` : undefined,
        )!,
      };
    }
    if (type === 'unaccepted-assets') {
      const accept = checkoutAcceptances;
      const matches = this.acceptances.subjects(scope, true);
      const types = (['asset', 'accessory', 'license', 'consumable'] as const).filter(
        (value) =>
          permitsKey(user, 'reports.view') ||
          permitsKey(
            user,
            (
              {
                asset: 'assets.checkout',
                accessory: 'accessories.checkout',
                license: 'licenses.checkout',
                consumable: 'consumables.checkout',
              } as const
            )[value],
          ),
      );
      const visibleUser = permitsEntity(user, 'users.view')
        ? sql`(select coalesce(${users.displayName}, ${users.username})
        from ${users} where ${users.id} = ${accept.assignedToId} and ${this.scope(scope, users, 'users')})`
        : sql`null`;
      return {
        from: sql`from ${accept} join lateral (${matches}) as item on true`,
        fields: {
          id: accept.id,
          item_type: sql`item.item_type`,
          name: sql`item.name`,
          asset_tag: sql`item.tag`,
          assigned_to: visibleUser,
          created_at: accept.createdAt,
        },
        where: and(
          isNull(accept.deletedAt),
          isNull(accept.acceptedAt),
          isNull(accept.declinedAt),
          types.length
            ? sql`item.item_type in (${sql.join(
                types.map((value) => sql`${value}`),
                sql`, `,
              )})`
            : sql`false`,
          query.from ? sql`${accept.createdAt} >= ${query.from}::date` : undefined,
          query.to ? sql`${accept.createdAt} < ${query.to}::date + 1` : undefined,
        )!,
      };
    }
    const resource = {
      licenses: 'licenses',
      accessories: 'accessories',
      'custom-components': 'components',
      'custom-consumables': 'consumables',
    }[type] as 'licenses' | 'accessories' | 'components' | 'consumables';
    const tables = { licenses, accessories, components, consumables };
    const table = tables[resource];
    const quantity = resource === 'licenses' ? licenses.seats : tables[resource].qty;
    const purchaseDate =
      resource === 'licenses' ? licenses.purchaseDate : tables[resource].legacyPurchaseDate;
    const purchaseCost =
      resource === 'licenses' ? licenses.purchaseCost : tables[resource].defaultPurchaseCost;
    const supplierId =
      resource === 'licenses' ? licenses.supplierId : tables[resource].defaultSupplierId;
    const date =
      resource === 'licenses' && query.date_field === 'expiration_date'
        ? licenses.expirationDate
        : purchaseDate;
    const fields = {
      id: table.id,
      name: table.name,
      company: companies.name,
      quantity,
      assigned: usedStock(resource),
      available: sql`greatest(0, ${quantity} - ${usedStock(resource)})`,
      purchase_date: purchaseDate,
      purchase_cost: purchaseCost,
      supplier: suppliers.name,
      notes: table.notes,
      ...(resource === 'licenses'
        ? {
            product_key: permitsKey(user, 'licenses.keys')
              ? licenses.serial
              : sql`case when ${licenses.serial} is not null then '***************' end`,
            expiration_date: licenses.expirationDate,
            termination_date: licenses.terminationDate,
          }
        : {}),
      ...(resource === 'accessories' ? { model_number: accessories.modelNumber } : {}),
      ...(resource === 'components' ? { serial: components.serial } : {}),
      ...(resource === 'consumables' ? { item_no: consumables.itemNo } : {}),
    };
    return {
      from: sql`from ${table} left join ${companies} on ${companies.id} = ${table.companyId}
      left join ${suppliers} on ${suppliers.id} = ${supplierId}`,
      fields,
      where: and(
        isNull(table.deletedAt),
        this.scope(scope, table, resource),
        query.company_id ? eq(table.companyId, query.company_id) : undefined,
        query.supplier_id ? eq(supplierId, query.supplier_id) : undefined,
        query.category_id ? eq(table.categoryId, query.category_id) : undefined,
        query.from ? sql`${date} >= ${query.from}::date` : undefined,
        query.to ? sql`${date} <= ${query.to}::date` : undefined,
      )!,
    };
  }

  @Get('reports/activity/chart')
  async chart(@Query() raw: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    const query = parse(ReportQuerySchema, raw);
    const narrow = this.access(user, 'activity', query.scoped);
    const source = await this.source(
      'activity',
      query,
      user,
      await this.fmcs.resolve(user),
      narrow,
    );
    const { from } = this.projection(source, query);
    return success(
      await this.db.execute(sql`select action_date::date as date, count(*)::int as count ${from}
      group by action_date::date order by date`),
    );
  }

  @Get('dashboard/activity')
  dashboardActivity(
    @Query() raw: Record<string, unknown>,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUserContext,
    @Res() reply: FastifyReply,
  ) {
    return this.report('activity', { ...raw, scoped: 'true', format: undefined }, req, user, reply);
  }

  @Get('unaccepted-acceptances')
  pending(
    @Query() raw: unknown,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUserContext,
    @Res() reply: FastifyReply,
  ) {
    return this.report('unaccepted-assets', raw, req, user, reply);
  }

  @Get('reports/:type')
  async report(
    @Param('type') value: string,
    @Query() raw: unknown,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUserContext,
    @Res() reply: FastifyReply,
  ) {
    const type = parse(reportType, value);
    const query = parse(ReportQuerySchema, raw);
    if (query.from && query.to && query.from > query.to)
      throw new UnprocessableEntityException('Invalid report date range');
    const narrow = this.access(user, type, query.scoped);
    const source = await this.source(type, query, user, await this.fmcs.resolve(user), narrow);
    const custom =
      type === 'custom'
        ? await this.db
            .select({
              name: customFields.name,
              key: customFields.dbColumn,
              encrypted: customFields.fieldEncrypted,
            })
            .from(customFields)
        : [];
    const extra = custom
      .filter(
        (field) => !field.encrypted || permitsKey(user, 'assets.view.encrypted_custom_fields'),
      )
      .map((field) => field.key);
    const allowed = [
      ...Object.keys(source.fields).filter((field) => !source.hidden?.includes(field)),
      ...extra,
    ];
    const columns = query.columns
      ? [...new Set(query.columns.split(',').map((name) => name.trim()))]
      : allowed.filter((field) => !extra.includes(field));
    if (columns.some((field) => !allowed.includes(field)))
      throw new UnprocessableEntityException('Unknown or unavailable report column');
    const { from, order } = this.projection(source, query);
    const config = type === 'depreciation' ? await currentSettings(this.db) : undefined;
    const asOf = query.as_of ?? new Date().toISOString().slice(0, 10);
    const pages = async (offset: number, limit: number) => {
      const records = await this.db.execute<Row>(
        sql`select * ${from} order by ${order} limit ${limit} offset ${offset}`,
      );
      return Promise.all(
        records.map(async (row) => {
          if (type === 'depreciation') {
            const schedule = row._schedule as {
              months: number;
              depreciation_min: number | null;
              depreciation_type: 'percent' | 'amount';
              fiscal_year_start_month: number | null;
              rate_multiplier: number | null;
            } | null;
            row.book_value = depreciationValue(
              schedule
                ? {
                    months: schedule.months,
                    depreciationMin: schedule.depreciation_min?.toString() ?? null,
                    depreciationType: schedule.depreciation_type,
                    fiscalYearStartMonth: schedule.fiscal_year_start_month,
                    rateMultiplier: schedule.rate_multiplier?.toString() ?? null,
                  }
                : undefined,
              row.purchase_cost == null ? null : String(row.purchase_cost),
              row.purchase_date == null ? null : String(row.purchase_date).slice(0, 10),
              config?.depreciationMethod ?? 'default',
              asOf,
            );
          }
          if (type === 'custom' && columns.some((column) => extra.includes(column))) {
            const asset = await this.hardware.get(Number(row.id), user);
            for (const [key, field] of Object.entries(asset.custom_fields))
              row[field.field] = field.value;
          }
          return Object.fromEntries(columns.map((column) => [column, row[column] ?? null]));
        }),
      );
    };
    if (query.format) {
      const rows = async function* () {
        for (let offset = 0; ; offset += 500) {
          const batch = await pages(offset, 500);
          yield* batch;
          if (batch.length < 500) return;
        }
      };
      if (query.format === 'csv') {
        const stream = Readable.from(
          (async function* () {
            yield columns.map(csvCell).join(',') + '\r\n';
            for await (const row of rows())
              yield columns.map((column) => csvCell(row[column])).join(',') + '\r\n';
          })(),
        );
        return attachmentResponse(reply, `${type}.csv`, 'text/csv; charset=utf-8').send(stream);
      }
      const stream = new PassThrough();
      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream });
      const sheet = workbook.addWorksheet('Report');
      sheet.addRow(columns).commit();
      void (async () => {
        for await (const row of rows()) {
          sheet
            .addRow(
              columns.map((column) => {
                const value = row[column];
                return value && typeof value === 'object' && !(value instanceof Date)
                  ? JSON.stringify(value)
                  : value;
              }),
            )
            .commit();
        }
        await workbook.commit();
      })().catch((error: Error) => stream.destroy(error));
      return attachmentResponse(
        reply,
        `${type}.xlsx`,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ).send(stream);
    }
    const [total, rows] = await Promise.all([
      this.db.execute<{ total: number }>(sql`select count(*)::int as total ${from}`),
      pages(pageOffset(query), query.limit),
    ]);
    return reply.send({
      ...datatable(total[0]!.total, rows, query, req.url),
      columns,
      available_columns: allowed,
    });
  }

  private projection(source: ReportSource, query: ReportQuery) {
    const fields = sql.join(
      Object.entries(source.fields).map(
        ([name, value]) => sql`${value} as ${sql.identifier(name)}`,
      ),
      sql`, `,
    );
    const searchable = Object.keys(source.fields).filter(
      (name) => !source.hidden?.includes(name) && name !== 'product_key',
    );
    const search = query.search
      ? sql`where (${sql.join(
          searchable.map(
            (name) => sql`${sql.identifier(name)}::text ilike ${'%' + query.search + '%'}`,
          ),
          sql` or `,
        )})`
      : sql``;
    const sort = query.sort && searchable.includes(query.sort) ? query.sort : (source.sort ?? 'id');
    const order = sql`${sql.identifier(sort)} ${query.order === 'asc' ? sql`asc` : sql`desc`}, id desc`;
    return {
      from: sql`from (select ${fields} ${source.from} where ${source.where}) report ${search}`,
      order,
    };
  }

  @Get('report-templates')
  async templates(@CurrentUser() user: AuthenticatedUserContext) {
    requireInventoryPermission(user, 'reports.view', true);
    return success(
      await this.db
        .select()
        .from(reportTemplates)
        .where(
          and(
            isNull(reportTemplates.deletedAt),
            or(eq(reportTemplates.createdBy, user.id), eq(reportTemplates.isShared, true)),
          ),
        )
        .orderBy(reportTemplates.name),
    );
  }

  @Get('report-templates/:id')
  async template(@Param('id') id: string, @CurrentUser() user: AuthenticatedUserContext) {
    requireInventoryPermission(user, 'reports.view', true);
    const [row] = await this.db
      .select()
      .from(reportTemplates)
      .where(
        and(
          isNull(reportTemplates.deletedAt),
          eq(reportTemplates.id, parse(InventoryIdSchema, id)),
          or(eq(reportTemplates.createdBy, user.id), eq(reportTemplates.isShared, true)),
        ),
      );
    if (!row) throw new NotFoundException('Report template not found');
    return success(row);
  }

  @Post('report-templates')
  async create(@Body() raw: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    requireInventoryPermission(user, 'reports.view', true);
    const input = parse(templateInput, raw);
    const [row] = await this.db
      .insert(reportTemplates)
      .values({
        name: input.name,
        isShared: input.is_shared,
        createdBy: user.id,
        options: { ...input.options, report: input.report },
      })
      .returning();
    return success(row);
  }

  @Patch('report-templates/:id')
  async edit(
    @Param('id') id: string,
    @Body() raw: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    const input = parse(templateInput, raw);
    return this.change(id, user, {
      name: input.name,
      isShared: input.is_shared,
      options: { ...input.options, report: input.report },
    });
  }

  @Delete('report-templates/:id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUserContext) {
    return this.change(id, user, { deletedAt: new Date() });
  }

  private async change(
    value: string,
    user: AuthenticatedUserContext,
    values: Partial<typeof reportTemplates.$inferInsert>,
  ) {
    requireInventoryPermission(user, 'reports.view', true);
    const [row] = await this.db
      .update(reportTemplates)
      .set({ ...values, updatedAt: new Date() })
      .where(
        and(
          eq(reportTemplates.id, parse(InventoryIdSchema, value)),
          eq(reportTemplates.createdBy, user.id),
          isNull(reportTemplates.deletedAt),
        ),
      )
      .returning();
    if (!row) throw new NotFoundException('Report template not found');
    return success(row);
  }
}

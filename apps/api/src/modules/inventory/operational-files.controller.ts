import {
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  DatatableQuerySchema,
  InventoryIdSchema,
  type AuthenticatedUserContext,
  type PermissionKey,
  type StorageBucketCategory,
} from '@kestrel-it/shared';
import { and, desc, eq, getTableColumns, isNotNull, isNull, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import { permitsEntity } from '../../common/guards/permissions.guard.js';
import { STORAGE_PROVIDER, type StorageProvider } from '../../common/storage/storage.interface.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import {
  accessories,
  actionLogs,
  assetMaintenances,
  assets,
  companies,
  components,
  consumables,
  departments,
  licenses,
  locations,
  models,
  suppliers,
  users,
} from '../../db/schema/index.js';
import { FmcsScopeService } from './fmcs-scope.service.js';
import {
  contains,
  inventoryWrite,
  parse,
  success,
  type InventoryDatabase,
} from './inventory-queries.js';
import {
  inventoryPage,
  requireInventoryPermission,
  writeInventoryLog,
} from './phase-three-queries.js';

const resources = {
  hardware: [assets, 'asset', 'assets', 'assets.files'],
  audits: [assets, 'asset', 'audits', 'assets.files'],
  models: [models, 'model', 'models', 'models.files'],
  licenses: [licenses, 'license', 'licenses', 'licenses.files'],
  accessories: [accessories, 'accessory', 'accessories', 'accessories.files'],
  consumables: [consumables, 'consumable', 'consumables', 'consumables.files'],
  components: [components, 'component', 'components', 'components.files'],
  users: [users, 'user', 'users', 'users.files'],
  companies: [companies, 'company', 'companies', 'companies.files'],
  departments: [departments, 'department', 'departments', 'departments.files'],
  locations: [locations, 'location', 'locations', 'locations.files'],
  suppliers: [suppliers, 'supplier', 'suppliers', 'suppliers.files'],
  maintenances: [assetMaintenances, 'maintenance', 'maintenances', 'assets.edit'],
} satisfies Record<string, [PgTable, string, StorageBucketCategory, PermissionKey]>;

const MAX_BYTES = 10 * 1024 * 1024;
const cleanName = (name: string) =>
  name
    .split(/[\\/]/)
    .at(-1)!
    .replace(/[\x00-\x1f\x7f]/g, '')
    .slice(0, 180);

function fileMime(filename: string, bytes: Buffer) {
  const extension = filename.split('.').at(-1)?.toLowerCase();
  const begins = (hex: string) => bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
  if (extension === 'pdf' && begins('255044462d')) return 'application/pdf';
  if (extension === 'png' && begins('89504e470d0a1a0a')) return 'image/png';
  if (['jpg', 'jpeg'].includes(extension ?? '') && begins('ffd8ff')) return 'image/jpeg';
  if (extension === 'gif' && begins('47494638')) return 'image/gif';
  if (extension === 'zip' && begins('504b0304')) return 'application/zip';
  if (['docx', 'xlsx', 'pptx', 'odt', 'ods'].includes(extension ?? '') && begins('504b0304'))
    return 'application/octet-stream';
  if (
    ['txt', 'csv', 'log', 'xml'].includes(extension ?? '') &&
    !bytes.includes(0) &&
    !bytes.toString('utf8').includes('\ufffd')
  )
    return 'text/plain';
  throw new UnprocessableEntityException('Unsupported attachment type or invalid file contents');
}

export function attachmentResponse(
  reply: FastifyReply,
  name: string,
  mime = 'application/octet-stream',
) {
  const ascii = name.replace(/[^a-zA-Z0-9_. -]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (value) => '%' + value.charCodeAt(0).toString(16),
  );
  return reply
    .type(mime)
    .header('Cache-Control', 'private, no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`);
}

@Controller([
  'hardware',
  'assets',
  'audits',
  'models',
  'licenses',
  'accessories',
  'consumables',
  'components',
  'users',
  'companies',
  'departments',
  'locations',
  'suppliers',
  'maintenances',
])
export class OperationalFilesController {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(STORAGE_PROVIDER) private readonly store: StorageProvider,
    @Inject(FmcsScopeService) private readonly fmcs: FmcsScopeService,
  ) {}

  private async parent(
    req: FastifyRequest,
    value: string,
    user: AuthenticatedUserContext,
    write: boolean,
    db: InventoryDatabase = this.db,
  ) {
    const routeResource = /\/([^/]+)\/[^/]+\/files(?:\/|$)/.exec(req.url.split('?')[0]!)?.[1];
    const resource = (
      routeResource === 'assets' ? 'hardware' : routeResource
    ) as keyof typeof resources;
    const definition = resources[resource];
    if (!definition) throw new NotFoundException('Attachment parent not found');
    const [table, type, bucket, permission] = definition;
    const id = parse(InventoryIdSchema, value);
    if (write || resource !== 'models' || !permitsEntity(user, 'assets.view'))
      requireInventoryPermission(user, permission, resource === 'models');
    const scope = await this.fmcs.resolve(user, db);
    const columns = getTableColumns(table as PgTable);
    const guard =
      resource === 'maintenances'
        ? sql`exists (select 1 from ${assets} where ${assets.id} = ${assetMaintenances.itemId} and ${assets.deletedAt} is null and ${this.fmcs.predicate(scope, 'assets', assets.id, assets.companyId) ?? sql`true`})`
        : this.fmcs.predicate(scope, resource, columns.id!, columns.companyId);
    const [parent] = await db
      .select({
        company:
          resource === 'maintenances'
            ? sql<
                number | null
              >`(select company_id from assets where id = ${assetMaintenances.itemId})`
            : (columns.companyId ?? sql<number | null>`null`),
      })
      .from(table as PgTable)
      .where(
        and(
          eq(columns.id!, id),
          guard,
          write && columns.deletedAt ? isNull(columns.deletedAt) : undefined,
        ),
      );
    if (!parent) throw new NotFoundException('Attachment parent not found');
    return {
      id,
      type,
      bucket,
      companyId: resource === 'companies' ? id : (parent.company as number | null),
    };
  }

  private filter(parent: { id: number; type: string; bucket: StorageBucketCategory }) {
    const upload = and(
      eq(actionLogs.actionType, 'uploaded'),
      sql`${actionLogs.logMeta}->>'bucket' = ${parent.bucket}`,
    );
    const audit =
      parent.bucket === 'audits' ? sql`(${upload} or ${actionLogs.actionType} = 'audit')` : upload;
    return and(
      eq(actionLogs.itemId, parent.id),
      eq(actionLogs.itemType, parent.type),
      isNull(actionLogs.deletedAt),
      isNotNull(actionLogs.filename),
      audit,
    );
  }

  @Get(':id/files')
  async list(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Query() raw: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    const parent = await this.parent(req, id, user, false);
    const query = parse(DatatableQuerySchema, raw);
    const filename = sql<string>`coalesce(${actionLogs.logMeta}->>'name', ${actionLogs.filename})`;
    return inventoryPage(
      this.db,
      actionLogs,
      {
        id: actionLogs.id,
        filename,
        note: actionLogs.note,
        created_at: actionLogs.createdAt,
        action_type: actionLogs.actionType,
        uploaded_by: permitsEntity(user, 'users.view')
          ? actionLogs.createdBy
          : sql<number | null>`null`,
      },
      and(
        this.filter(parent),
        parent.bucket === 'audits'
          ? this.fmcs.predicate(
              await this.fmcs.resolve(user),
              'history',
              actionLogs.id,
              actionLogs.companyId,
            )
          : undefined,
        query.search
          ? sql`(${filename} ilike ${'%' + query.search + '%'} or ${contains(actionLogs.note, query.search)})`
          : undefined,
      ),
      query.order === 'asc' ? [sql`${actionLogs.id} asc`] : [desc(actionLogs.id)],
      query,
      req.url,
    );
  }

  @Post(':id/files')
  async upload(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    const parent = await this.parent(req, id, user, true);
    if (!req.isMultipart())
      throw new UnprocessableEntityException('Expected a multipart attachment');
    let note: string | null = null;
    const staged: { key: string; name: string; mime: string; size: number }[] = [];
    try {
      for await (const part of req.parts({
        limits: { files: 5, fields: 2, fileSize: MAX_BYTES, fieldSize: 5000 },
      })) {
        if (part.type === 'field') {
          if (part.fieldname === 'notes' || part.fieldname === 'note')
            note = String(part.value).trim().slice(0, 5000) || null;
          continue;
        }
        const bytes = await part.toBuffer();
        const name = cleanName(part.filename);
        const mime = fileMime(name, bytes);
        const key = `attachments/${parent.id}/${randomUUID()}`;
        staged.push({ key, name, mime, size: bytes.length });
        await this.store.putObject(parent.bucket, key, bytes, mime);
      }
      if (!staged.length) throw new UnprocessableEntityException('Choose at least one file');
      return await inventoryWrite(this.db, async (tx) => {
        const current = await this.parent(req, id, user, true, tx);
        const results = [];
        for (const file of staged) {
          const [record] = await writeInventoryLog(tx, {
            createdBy: user.id,
            actionType: 'uploaded',
            itemType: current.type,
            itemId: current.id,
            companyId: current.companyId,
            filename: file.key,
            note,
            logMeta: { name: file.name, size: file.size, mime: file.mime, bucket: current.bucket },
          });
          results.push({ id: record!.id, filename: file.name, note });
        }
        return success(results);
      });
    } catch (error) {
      await Promise.allSettled(
        staged.map((file) => this.store.deleteObject(parent.bucket, file.key)),
      );
      throw error;
    }
  }

  @Get(':id/files/:file')
  async download(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Param('file') file: string,
    @CurrentUser() user: AuthenticatedUserContext,
    @Res() reply: FastifyReply,
  ) {
    const parent = await this.parent(req, id, user, false);
    const [entry] = await this.db
      .select()
      .from(actionLogs)
      .where(
        and(
          this.filter(parent),
          eq(actionLogs.id, parse(InventoryIdSchema, file)),
          parent.bucket === 'audits'
            ? this.fmcs.predicate(
                await this.fmcs.resolve(user),
                'history',
                actionLogs.id,
                actionLogs.companyId,
              )
            : undefined,
        ),
      );
    if (!entry?.filename) throw new NotFoundException('Attachment not found');
    const result = await this.store.getObjectStream(parent.bucket, entry.filename);
    const name = typeof entry.logMeta?.name === 'string' ? entry.logMeta.name : `audit-${entry.id}`;
    const mime = typeof entry.logMeta?.mime === 'string' ? entry.logMeta.mime : result.mimeType;
    if (result.size !== undefined) reply.header('Content-Length', result.size);
    return attachmentResponse(reply, name, mime).send(result.stream);
  }

  @Delete([':id/files/:file/delete', ':id/files/:file'])
  async remove(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Param('file') file: string,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return inventoryWrite(this.db, async (tx) => {
      const parent = await this.parent(req, id, user, true, tx);
      if (parent.bucket === 'audits') throw new NotFoundException('Attachment not found');
      const [entry] = await tx
        .select()
        .from(actionLogs)
        .where(and(this.filter(parent), eq(actionLogs.id, parse(InventoryIdSchema, file))))
        .for('update');
      if (!entry?.filename) throw new NotFoundException('Attachment not found');
      if (await this.store.exists(parent.bucket, entry.filename))
        await this.store.deleteObject(parent.bucket, entry.filename);
      await tx.update(actionLogs).set({ deletedAt: new Date() }).where(eq(actionLogs.id, entry.id));
      await writeInventoryLog(tx, {
        createdBy: user.id,
        actionType: 'upload deleted',
        itemType: parent.type,
        itemId: parent.id,
        companyId: parent.companyId,
        logMeta: { attachmentId: entry.id },
      });
      return success(null, 'Attachment deleted');
    });
  }
}

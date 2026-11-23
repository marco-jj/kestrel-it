import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  DatatableQuerySchema,
  IMPORT_TYPES,
  ImportProcessSchema,
  InventoryIdSchema,
  type AuthenticatedUserContext,
  type ImportType,
} from '@kestrel-it/shared';
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import { STORAGE_PROVIDER, type StorageProvider } from '../../common/storage/storage.interface.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import {
  customFields,
  importRowErrors,
  imports,
  storageDeletionQueue,
  type ImportRun,
} from '../../db/schema/index.js';
import { AuthService } from '../auth/auth.service.js';
import { automaticMapping, csvRows, importFields, normalizedHeader } from './import-mapping.js';
import { ImportRecordsService } from './import-records.service.js';
import { inventoryWrite, parse, success, type InventoryDatabase } from './inventory-queries.js';
import { attachmentResponse } from './operational-files.controller.js';
import { inventoryPage, requireInventoryPermission } from './phase-three-queries.js';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_ROWS = 100_000;
const previewFields = new Set([
  'name',
  'asset_name',
  'item_name',
  'model',
  'model_number',
  'asset_tag',
  'category',
  'manufacturer',
  'location',
  'supplier',
  'qty',
  'quantity',
  'status',
  'company',
  'item_no',
  'purchase_date',
]);
const timestamp = () => new Date();

function maskPreview(headers: string[], row: string[]) {
  return headers.map((header, index) =>
    !row[index]
      ? ''
      : previewFields.has(normalizedHeader(header))
        ? row[index]!.slice(0, 180)
        : '••••',
  );
}

@Controller('imports')
export class ImportsController {
  private readonly logger = new Logger(ImportsController.name);
  private busy = false;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ImportRecordsService) private readonly records: ImportRecordsService,
  ) {}

  private owner(user: AuthenticatedUserContext) {
    requireInventoryPermission(user, 'import', true);
    return user.isSuperUser ? undefined : eq(imports.createdBy, user.id);
  }

  private async file(id: number, user: AuthenticatedUserContext, db: InventoryDatabase = this.db) {
    const [file] = await db
      .select()
      .from(imports)
      .where(and(eq(imports.id, id), this.owner(user)));
    if (!file) throw new NotFoundException('Import file not found');
    return file;
  }

  private summary(file: typeof imports.$inferSelect) {
    const { id, name, filesize, importType, headerRow, firstRow, fieldMap, run, createdAt } = file;
    return {
      id,
      name,
      filesize,
      import_type: importType,
      header_row: headerRow,
      first_row: firstRow,
      field_map: fieldMap,
      created_at: createdAt,
      run: run
        ? {
            state: run.state,
            processed: run.cursor,
            created: run.created,
            updated: run.updated,
            skipped: run.skipped,
            errored: run.errored,
            error: run.error,
            update_existing: run.updateExisting,
            preserve_blanks: run.preserveBlanks,
            send_welcome: run.sendWelcome,
          }
        : null,
    };
  }

  @Get()
  list(
    @Query() raw: unknown,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    const query = parse(DatatableQuerySchema, raw);
    return inventoryPage(
      this.db,
      imports,
      {
        id: imports.id,
        name: imports.name,
        filesize: imports.filesize,
        created_at: imports.createdAt,
        import_type: imports.importType,
        state: sql<string>`${imports.run}->>'state'`,
      },
      and(
        this.owner(user),
        query.search ? sql`${imports.name} ilike ${'%' + query.search + '%'}` : undefined,
      ),
      [desc(imports.id)],
      query,
      req.url,
    );
  }

  @Post()
  async upload(@Req() req: FastifyRequest, @CurrentUser() user: AuthenticatedUserContext) {
    this.owner(user);
    if (!req.isMultipart()) throw new UnprocessableEntityException('Expected multipart CSV files');
    const staged: {
      name: string;
      filePath: string;
      filesize: number;
      headerRow: string[];
      firstRow: string[];
    }[] = [];
    const keys: string[] = [];
    try {
      for await (const part of req.parts({
        limits: { files: 8, fields: 3, fileSize: MAX_BYTES },
      })) {
        if (part.type !== 'file') continue;
        const name = part.filename
          .split(/[\\/]/)
          .at(-1)!
          .replace(/[\x00-\x1f\x7f]/g, '')
          .slice(0, 250);
        if (!name.toLowerCase().endsWith('.csv'))
          throw new UnprocessableEntityException('Choose CSV files');
        const filePath = `uploads/${randomUUID()}.csv`;
        keys.push(filePath);
        let filesize = 0;
        const { Readable } = await import('node:stream');
        const stream = Readable.from(
          (async function* () {
            for await (const value of part.file) {
              const chunk = Buffer.from(value);
              filesize += chunk.length;
              yield chunk;
            }
            if (part.file.truncated)
              throw new UnprocessableEntityException('CSV file exceeds 25 MiB');
          })(),
        );
        await this.storage.putObject('imports', filePath, stream, 'text/csv');
        const object = await this.storage.getObjectStream('imports', filePath);
        const iterator = csvRows(object.stream);
        let headerRow: string[];
        let firstRow: string[];
        try {
          const headers = await iterator.next();
          const first = await iterator.next();
          if (headers.done || first.done)
            throw new UnprocessableEntityException('CSV requires headers and at least one record');
          headerRow = headers.value.map((header) => header.trim());
          if (headerRow.length > 200 || headerRow.some((header) => header.length > 200 || !header))
            throw new UnprocessableEntityException('CSV has invalid headers');
          firstRow = maskPreview(headerRow, first.value);
        } finally {
          await iterator.return(undefined);
        }
        staged.push({ name, filePath, filesize, headerRow, firstRow });
      }
      if (!staged.length) throw new UnprocessableEntityException('Choose at least one CSV file');
      const rows = await this.db
        .insert(imports)
        .values(staged.map((file) => ({ ...file, createdBy: user.id })))
        .returning();
      return success(rows.map((row) => this.summary(row)));
    } catch (error) {
      await Promise.allSettled(keys.map((key) => this.storage.deleteObject('imports', key)));
      if (error instanceof UnprocessableEntityException) throw error;
      throw new UnprocessableEntityException('CSV could not be read or stored');
    }
  }

  @Get(':id')
  async preview(
    @Param('id') value: string,
    @Query('import_type') rawType: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    const file = await this.file(parse(InventoryIdSchema, value), user);
    const type = rawType === undefined ? undefined : parse(z.enum(IMPORT_TYPES), rawType);
    const custom = type === 'asset' ? await this.custom() : [];
    const aliases = Object.fromEntries(
      custom.flatMap(({ name, key }) => [
        [normalizedHeader(name), `custom:${key}`],
        [normalizedHeader(key), `custom:${key}`],
      ]),
    );
    return success({
      ...this.summary(file),
      fields: type ? [...importFields[type], ...custom.map((field) => `custom:${field.key}`)] : [],
      suggested_map: type ? automaticMapping(type, file.headerRow ?? [], aliases) : {},
    });
  }

  private custom() {
    return this.db
      .select({ name: customFields.name, key: customFields.dbColumn })
      .from(customFields);
  }

  @Get(':id/download')
  async download(
    @Param('id') value: string,
    @Res() reply: FastifyReply,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    const file = await this.file(parse(InventoryIdSchema, value), user);
    const { stream } = await this.storage.getObjectStream('imports', file.filePath);
    return attachmentResponse(reply, file.name ?? 'import.csv').send(stream);
  }

  @Delete(':id')
  async remove(@Param('id') value: string, @CurrentUser() user: AuthenticatedUserContext) {
    const id = parse(InventoryIdSchema, value);
    return inventoryWrite(this.db, async (tx) => {
      const file = await this.file(id, user, tx);
      if (file.run?.state === 'queued' || file.run?.state === 'running')
        throw new ConflictException('The CSV is processing');
      await tx
        .insert(storageDeletionQueue)
        .values({ category: 'imports', objectKey: file.filePath })
        .onConflictDoNothing();
      await tx.delete(imports).where(eq(imports.id, id));
      return success(null);
    });
  }

  @Post('process/:id')
  async queue(
    @Param('id') value: string,
    @Body() raw: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    const id = parse(InventoryIdSchema, value);
    const body = z.object({}).passthrough().parse(raw);
    const input = parse(ImportProcessSchema, {
      ...body,
      import_type: body.import_type ?? body['import-type'],
      field_map: body.field_map ?? body['column-mappings'],
      update_existing: body.update_existing ?? body['import-update'],
      preserve_blanks: body.preserve_blanks ?? body['import-preserve-blanks'],
      send_welcome: body.send_welcome ?? body['send-welcome'],
    });
    const custom =
      input.import_type === 'asset'
        ? (await this.custom()).map((field) => `custom:${field.key}`)
        : [];
    const fields = new Set([...importFields[input.import_type], ...custom]);
    return inventoryWrite(this.db, async (tx) => {
      const file = await this.file(id, user, tx);
      const headers = file.headerRow ?? [];
      const map: Record<string, string> = {};
      for (const [key, field] of Object.entries(input.field_map)) {
        if (!field) continue;
        const positions = /^\d+$/.test(key)
          ? [Number(key)]
          : headers.flatMap((header, index) => (header === key ? [index] : []));
        if (
          positions.length !== 1 ||
          positions[0]! >= headers.length ||
          !fields.has(field) ||
          Object.values(map).includes(field)
        )
          throw new UnprocessableEntityException('CSV column mapping is invalid or ambiguous');
        map[String(positions[0])] = field;
      }
      const mapped = new Set(Object.values(map));
      const required: Partial<Record<ImportType, string[]>> = {
        assetHistory: ['asset_tag', 'checkout_at'],
        assetModel: ['name'],
        accessory: ['name'],
        component: ['name'],
        consumable: ['name'],
        license: ['name'],
        location: ['name'],
        manufacturer: ['name'],
        supplier: ['name'],
        category: ['name', 'category_type'],
      };
      if (
        !mapped.size ||
        required[input.import_type]?.some((field) => !mapped.has(field)) ||
        (input.import_type === 'user' &&
          !['username', 'email', 'first_name', 'last_name'].some((field) => mapped.has(field)))
      )
        throw new UnprocessableEntityException('Map the required CSV columns before processing');
      const previous = file.run;
      if (
        previous?.state === 'running' ||
        previous?.state === 'queued' ||
        previous?.state === 'complete'
      )
        return success(this.summary(file));
      const same =
        file.importType === input.import_type &&
        JSON.stringify(map) === JSON.stringify(file.fieldMap) &&
        previous?.updateExisting === input.update_existing &&
        previous.preserveBlanks === input.preserve_blanks &&
        previous.sendWelcome === input.send_welcome;
      if (previous?.cursor && !same)
        throw new ConflictException(
          'A partially processed CSV must resume with its original mapping and options',
        );
      const run: ImportRun = {
        cursor: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        errored: 0,
        ...previous,
        state: 'queued',
        actorId: user.id,
        error: undefined,
        worker: undefined,
        updateExisting: input.update_existing,
        preserveBlanks: input.preserve_blanks,
        sendWelcome: input.send_welcome,
      };
      const [saved] = await tx
        .update(imports)
        .set({ run, importType: input.import_type, fieldMap: map, updatedAt: timestamp() })
        .where(eq(imports.id, id))
        .returning();
      return success(this.summary(saved!));
    });
  }

  @Get(':id/progress')
  async progress(
    @Param('id') value: string,
    @Query() raw: unknown,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    const file = await this.file(parse(InventoryIdSchema, value), user);
    const query = parse(DatatableQuerySchema, raw);
    return {
      ...(await inventoryPage(
        this.db,
        importRowErrors,
        {
          row_number: importRowErrors.rowNumber,
          message: importRowErrors.message,
        },
        eq(importRowErrors.importId, file.id),
        [asc(importRowErrors.rowNumber)],
        query,
        req.url,
      )),
      run: this.summary(file).run,
    };
  }

  @Interval(2000)
  async processOne() {
    if (this.busy) return false;
    this.busy = true;
    const worker = randomUUID();
    try {
      const file = await this.db.transaction(async (tx) => {
        const [candidate] = await tx
          .select()
          .from(imports)
          .where(
            or(
              sql`${imports.run}->>'state' = 'queued'`,
              and(
                sql`${imports.run}->>'state' = 'running'`,
                or(
                  isNull(imports.processingStartedAt),
                  sql`${imports.processingStartedAt} < now() - interval '5 minutes'`,
                ),
              ),
            ),
          )
          .orderBy(imports.id)
          .limit(1)
          .for('update', { skipLocked: true });
        if (!candidate?.run) return;
        const [claimed] = await tx
          .update(imports)
          .set({
            run: { ...candidate.run, state: 'running', worker },
            processingBy: candidate.run.actorId,
            processingStartedAt: timestamp(),
          })
          .where(eq(imports.id, candidate.id))
          .returning();
        return claimed;
      });
      if (!file?.run) return false;
      try {
        const object = await this.storage.getObjectStream('imports', file.filePath);
        const type = parse(z.enum(IMPORT_TYPES), file.importType);
        let index = -1;
        for await (const cells of csvRows(object.stream)) {
          index += 1;
          if (index <= file.run.cursor) continue;
          if (index > MAX_ROWS)
            throw new UnprocessableEntityException('CSV exceeds the maximum row count');
          if (!(await this.row(file, type, worker, index, cells))) return true;
        }
        await this.finish(file.id, worker, 'complete');
      } catch (error) {
        const message =
          error instanceof UnprocessableEntityException
            ? error.message
            : 'CSV processing stopped. Check the file and retry.';
        await this.finish(file.id, worker, 'failed', message);
      }
      return true;
    } catch {
      this.logger.warn('Unable to run a queued CSV import');
      return false;
    } finally {
      this.busy = false;
    }
  }

  private async row(
    file: typeof imports.$inferSelect,
    type: ImportType,
    worker: string,
    index: number,
    raw: string[],
  ) {
    return inventoryWrite(this.db, async (tx) => {
      const [active] = await tx.select().from(imports).where(eq(imports.id, file.id)).for('update');
      if (!active?.run || active.run.worker !== worker || active.run.cursor !== index - 1)
        return false;
      const run = active.run;
      const actor = await this.auth.loadUserContext(run.actorId, true, 'jwt', tx);
      requireInventoryPermission(actor, 'import', true);
      try {
        if (raw.length !== (file.headerRow?.length ?? 0))
          throw new UnprocessableEntityException('Column count does not match the header');
        const cells = Object.fromEntries(
          Object.entries(file.fieldMap ?? {}).flatMap(([position, field]) => {
            const value = raw[Number(position)]?.trim() ?? '';
            return value || !run.preserveBlanks ? [[field, value]] : [];
          }),
        );
        const outcome = await tx.transaction((rowTx) =>
          this.records.import(rowTx, actor, type, cells, run),
        );
        run[outcome] += 1;
      } catch (error) {
        run.errored += 1;
        const safe =
          error instanceof UnprocessableEntityException && typeof error.getResponse() === 'string'
            ? error.message
            : 'Row did not satisfy inventory validation, access, or availability rules';
        await tx
          .insert(importRowErrors)
          .values({ importId: file.id, rowNumber: index + 1, message: safe })
          .onConflictDoNothing();
      }
      run.cursor = index;
      await tx
        .update(imports)
        .set({ run, processingStartedAt: timestamp(), updatedAt: timestamp() })
        .where(eq(imports.id, file.id));
      return true;
    });
  }

  private async finish(id: number, worker: string, state: 'complete' | 'failed', error?: string) {
    await this.db.transaction(async (tx) => {
      const [file] = await tx.select().from(imports).where(eq(imports.id, id)).for('update');
      if (!file?.run || file.run.worker !== worker) return;
      await tx
        .update(imports)
        .set({
          run: { ...file.run, state, error, worker: undefined },
          processingBy: null,
          processingStartedAt: null,
          updatedAt: timestamp(),
        })
        .where(eq(imports.id, id));
    });
  }
}

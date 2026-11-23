import { InventoryMailService } from './inventory-mail.service.js';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import {
  AssetAuditSchema,
  type AuthenticatedUserContext,
  type DatatableQuery,
} from '@kestrel-it/shared';
import { and, asc, eq, gte, isNull, lt, lte, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { z } from 'zod';
import { permitsEntity } from '../../common/guards/permissions.guard.js';
import { STORAGE_PROVIDER, type StorageProvider } from '../../common/storage/storage.interface.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import { actionLogs, assets, locations } from '../../db/schema/index.js';
import { CustomFieldsValidationService, fieldIssue } from './custom-fields-validation.service.js';
import { addCalendarMonths } from './depreciation.js';
import { FmcsScopeService } from './fmcs-scope.service.js';
import { HardwareService } from './hardware.service.js';
import { contains, inventoryWrite, parse, success } from './inventory-queries.js';
import {
  currentSettings,
  inventoryPage,
  requireInventoryPermission,
  writeInventoryLog,
} from './phase-three-queries.js';

export const MAX_AUDIT_PHOTO_BYTES = 5 * 1024 * 1024;
type Audit = z.output<typeof AssetAuditSchema>;
type Photo = { bytes: Buffer; mime: string; extension: string };

function validatePhoto(bytes: Buffer): Photo {
  if (bytes.length > MAX_AUDIT_PHOTO_BYTES) fieldIssue('photo', 'Photo exceeds the 5 MB limit');
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width === 0 || height === 0 || width * height > 24_000_000)
      fieldIssue('photo', 'Photo dimensions are invalid');
    try {
      PNG.sync.read(bytes);
      return { bytes, mime: 'image/png', extension: 'png' };
    } catch {
      fieldIssue('photo', 'Invalid PNG photo');
    }
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes[bytes.length - 2] === 255 &&
    bytes[bytes.length - 1] === 217
  ) {
    return { bytes, mime: 'image/jpeg', extension: 'jpg' };
  }
  fieldIssue('photo', 'Select a PNG or JPEG photo');
}

@Injectable()
export class AssetAuditsService {
  constructor(
    @Inject(InventoryMailService) private readonly mail: InventoryMailService,
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(FmcsScopeService) private readonly fmcs: FmcsScopeService,
    @Inject(HardwareService) private readonly hardware: HardwareService,
    @Inject(CustomFieldsValidationService)
    private readonly validation: CustomFieldsValidationService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  async context(id: number, user: AuthenticatedUserContext) {
    requireInventoryPermission(user, 'assets.audit', true);
    const asset = await this.hardware.find(this.db, await this.fmcs.resolve(user), id);
    const entries = await this.hardware.assetFields(this.db, asset.modelId);
    return {
      id: asset.id,
      name: asset.name,
      asset_tag: asset.assetTag,
      model_id: asset.modelId,
      company_id: asset.companyId,
      custom_fields: this.validation.serialize(
        entries.filter(({ field }) => field.displayAudit),
        asset.customFields,
        user,
      ),
    };
  }

  async single(
    id: number | undefined,
    input: unknown,
    bytes: Buffer | undefined,
    user: AuthenticatedUserContext,
  ) {
    requireInventoryPermission(user, 'assets.audit', true);
    const dto = parse(AssetAuditSchema, input);
    const photo = bytes ? validatePhoto(bytes) : undefined;
    return success(await this.save(id, dto, photo, user), 'Audit recorded');
  }

  async bulk(input: unknown, bytes: Buffer | undefined, user: AuthenticatedUserContext) {
    requireInventoryPermission(user, 'assets.audit', true);
    const dto = parse(AssetAuditSchema, input);
    if (!dto.ids?.length) fieldIssue('ids', 'Select at least one asset');
    const photo = bytes ? validatePhoto(bytes) : undefined;
    const results = [];
    for (const id of dto.ids) {
      try {
        results.push({ id, ...success(await this.save(id, dto, photo, user), 'Audit recorded') });
      } catch (error) {
        const exception = error as { getResponse?: () => unknown; message?: string };
        const response = exception.getResponse?.() as
          { messages?: unknown; message?: unknown } | undefined;
        results.push({
          id,
          status: 'error',
          payload: null,
          messages: response?.messages ?? response?.message ?? 'Audit could not be recorded',
        });
      }
    }
    const completed = results.filter((row) => row.status === 'success').length;
    return {
      status: completed > 0 ? 'success' : 'error',
      messages: `${completed} of ${results.length} audits recorded`,
      results,
    };
  }

  private async save(
    id: number | undefined,
    dto: Audit,
    photo: Photo | undefined,
    user: AuthenticatedUserContext,
  ) {
    const scope = await this.fmcs.resolve(user);
    const lookup = dto.audit_key ?? dto.asset_tag;
    if (id === undefined && !lookup) fieldIssue('asset_tag', 'Provide an audit key');
    const serial = id === undefined && dto.audit_by_field === 'serial' && !!dto.audit_key;
    const selector = id ?? lookup!;
    const resolve = async (
      db: Parameters<HardwareService['find']>[0],
      activeScope: typeof scope,
      lock: boolean,
    ) => {
      if (!serial) return this.hardware.find(db, activeScope, selector, { lock });
      if (!(await currentSettings(db))?.uniqueSerial)
        fieldIssue('audit_by_field', 'Serial lookup requires unique serial numbers');
      const filter = and(eq(assets.serial, lookup!), this.hardware.visible(activeScope));
      const query = db.select().from(assets).where(filter).orderBy(assets.id).limit(2);
      const rows = await (lock ? query.for('update') : query);
      if (!rows.length) throw new NotFoundException('Asset not found');
      if (rows.length > 1) throw new ConflictException('Asset serial is ambiguous');
      return rows[0]!;
    };
    let key: string | undefined;
    let finalizing = false;
    try {
      if (photo) {
        await resolve(this.db, scope, false);
        key = `${randomUUID()}.${photo.extension}`;
        await this.storage.putObject('audits', key, photo.bytes, photo.mime);
      }
      finalizing = true;
      return await inventoryWrite(this.db, async (tx) => {
        const activeScope = await this.fmcs.resolve(user, tx);
        const asset = await resolve(tx, activeScope, true);
        const now = new Date();
        const config = await currentSettings(tx);
        const interval = config?.auditInterval;
        const next =
          dto.next_audit_date ??
          (interval == null ? null : addCalendarMonths(now, interval).toISOString().slice(0, 10));
        const locationId = dto.location_id;
        if (locationId != null) {
          const [location] = await tx
            .select()
            .from(locations)
            .where(
              and(
                eq(locations.id, locationId),
                isNull(locations.deletedAt),
                this.fmcs.predicate(activeScope, 'locations', locations.id, locations.companyId),
              ),
            );
          if (
            !location ||
            (activeScope.scopeLocations &&
              !this.fmcs.compatible(
                activeScope,
                asset.companyId,
                location.companyId === null ? [] : [location.companyId],
              ))
          )
            fieldIssue('location_id', 'The location is unavailable for this asset');
        }
        if (dto.update_location && dto.location_id === undefined)
          fieldIssue('location_id', 'Choose a location');
        const entries = await this.hardware.assetFields(tx, asset.modelId);
        const customFields = await this.validation.prepare(tx, {
          entries,
          submitted: dto.custom_fields,
          existing: asset.customFields,
          assetId: asset.id,
          mode: 'audit',
        });
        await tx
          .update(assets)
          .set({
            lastAuditDate: now,
            nextAuditDate: next,
            updatedAt: now,
            customFields,
            locationId: dto.update_location ? locationId : undefined,
            name: dto.clear_name ? null : undefined,
          })
          .where(eq(assets.id, asset.id));
        const [log] = await writeInventoryLog(tx, {
          itemType: 'asset',
          itemId: asset.id,
          companyId: asset.companyId,
          actionType: 'audit',
          createdBy: user.id,
          actionDate: now,
          locationId: locationId ?? asset.locationId,
          note: dto.note,
          filename: key,
          logMeta: { next_audit_date: next },
        });
        await this.mail.lifecycle(tx, {
          event: 'audit.recorded', companyId: asset.companyId, suppressEmail: true,
          subject: `Asset audited: ${asset.assetTag}`, message: `The physical audit of ${asset.assetTag} was recorded.`,
        });
        return {
          id: asset.id,
          asset_tag: asset.assetTag,
          last_audit_date: now.toISOString(),
          next_audit_date: next,
          audit_id: log!.id,
          has_photo: !!key,
          custom_fields: this.validation.serialize(entries, customFields, user),
        };
      });
    } catch (error) {
      if (key) {
        try {
          const [reference] = finalizing
            ? await this.db
                .select({ id: actionLogs.id })
                .from(actionLogs)
                .where(eq(actionLogs.filename, key))
                .limit(1)
            : [];
          if (!reference) await this.storage.deleteObject('audits', key);
        } catch {
          // A storage failure or an unknown commit outcome should preserve the database error.
        }
      }
      throw error;
    }
  }

  async list(
    action: 'audit' | 'audits' | 'checkins',
    due: 'due' | 'overdue' | 'due-or-overdue',
    query: DatatableQuery,
    user: AuthenticatedUserContext,
    url: string,
  ) {
    if (action === 'checkins' || !permitsEntity(user, 'assets.view')) {
      requireInventoryPermission(
        user,
        action === 'checkins' ? 'assets.view' : 'assets.audit',
        action !== 'checkins',
      );
    }
    const scope = await this.fmcs.resolve(user);
    const config = await currentSettings(this.db);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const warningDays =
      action === 'checkins' ? (config?.dueCheckinDays ?? 7) : (config?.auditWarningDays ?? 14);
    now.setUTCDate(now.getUTCDate() + warningDays);
    const column = action === 'checkins' ? assets.expectedCheckin : assets.nextAuditDate;
    const cutoff = now.toISOString().slice(0, 10);
    return inventoryPage(
      this.db,
      assets,
      {
        id: assets.id,
        asset_tag: assets.assetTag,
        name: assets.name,
        model_id: assets.modelId,
        company_id: assets.companyId,
        location_id: assets.locationId,
        next_audit_date: assets.nextAuditDate,
        expected_checkin: assets.expectedCheckin,
      },
      and(
        this.hardware.visible(scope),
        due === 'overdue' ? lt(column, today) : lte(column, cutoff),
        due === 'due' ? gte(column, today) : undefined,
        query.search
          ? or(contains(assets.assetTag, query.search), contains(assets.name, query.search))
          : undefined,
      ),
      [asc(column), asc(assets.id)],
      query,
      url,
    );
  }

  async download(assetId: number, auditId: number, user: AuthenticatedUserContext) {
    if (!permitsEntity(user, 'assets.view')) requireInventoryPermission(user, 'assets.audit', true);
    const scope = await this.fmcs.resolve(user);
    await this.hardware.find(this.db, scope, assetId);
    const [log] = await this.db
      .select({ filename: actionLogs.filename })
      .from(actionLogs)
      .where(
        and(
          eq(actionLogs.id, auditId),
          eq(actionLogs.itemId, assetId),
          eq(actionLogs.itemType, 'asset'),
          eq(actionLogs.actionType, 'audit'),
          isNull(actionLogs.deletedAt),
          this.fmcs.predicate(scope, 'history', actionLogs.id, actionLogs.companyId),
        ),
      );
    if (!log?.filename) throw new NotFoundException('Audit photo not found');
    const object = await this.storage.getObjectStream('audits', log.filename);
    const png = log.filename.endsWith('.png');
    return new StreamableFile(object.stream, {
      type: png ? 'image/png' : 'image/jpeg',
      length: object.size,
      disposition: `attachment; filename="audit-${auditId}.${png ? 'png' : 'jpg'}"`,
    });
  }
}

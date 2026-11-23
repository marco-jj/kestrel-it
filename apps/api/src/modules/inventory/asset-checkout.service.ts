import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AssetCheckinInputSchema,
  AssetCheckoutInputSchema,
  type AuthenticatedUserContext,
  type CheckoutTargetType,
} from '@kestrel-it/shared';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { z } from 'zod';
import { permitsKey } from '../../common/guards/permissions.guard.js';
import type { EnvConfig } from '../../config/env.schema.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import {
  actionLogs,
  assets,
  categories,
  checkoutAcceptances,
  companyUser,
  licenseSeats,
  licenses,
  locations,
  models,
  settings,
  users,
} from '../../db/schema/index.js';
import { CustomFieldsValidationService, fieldIssue } from './custom-fields-validation.service.js';
import { FmcsScopeService, type FmcsScope } from './fmcs-scope.service.js';
import { HardwareService, assetStatus, type Hardware } from './hardware.service.js';
import { InventoryMailService } from './inventory-mail.service.js';
import { inventoryWrite, parse, success, type InventoryTransaction } from './inventory-queries.js';

type CheckoutInput = z.output<typeof AssetCheckoutInputSchema>;

export const pendingAcceptance = (type: 'asset' | 'license_seat', id: number) =>
  and(
    eq(checkoutAcceptances.checkoutableType, type),
    eq(checkoutAcceptances.checkoutableId, id),
    isNull(checkoutAcceptances.deletedAt),
    isNull(checkoutAcceptances.acceptedAt),
    isNull(checkoutAcceptances.declinedAt),
  );

@Injectable()
export class AssetCheckoutService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(ConfigService) private readonly env: ConfigService<EnvConfig, true>,
    @Inject(FmcsScopeService) private readonly fmcs: FmcsScopeService,
    @Inject(HardwareService) private readonly hardware: HardwareService,
    @Inject(CustomFieldsValidationService)
    private readonly validation: CustomFieldsValidationService,
    @Inject(InventoryMailService) private readonly mail: InventoryMailService,
  ) {}

  async checkout(selector: number | string, body: unknown, user: AuthenticatedUserContext) {
    const dto = parse(AssetCheckoutInputSchema, body);
    return inventoryWrite(this.db, async (tx) => {
      const scope = await this.fmcs.resolve(user, tx);
      return success(await this.checkoutInTransaction(tx, selector, dto, user, scope));
    });
  }

  async checkoutInTransaction(
    tx: InventoryTransaction,
    selector: number | string,
    dto: CheckoutInput,
    user: AuthenticatedUserContext,
    scope: FmcsScope,
  ) {
    if (!permitsKey(user, 'assets.checkout'))
      throw new ForbiddenException('Checkout permission required');
    const asset = await this.hardware.find(tx, scope, selector, { lock: true });
    const status = await this.hardware.status(tx, asset.statusId);
    if (assetStatus(asset, status) !== 'deployable' || asset.assignedTo !== null) {
      throw new ConflictException('The asset is unavailable for checkout');
    }
    const { category, config } = await this.workflowSettings(tx, asset);
    if (config?.requireCheckinoutNotes && !dto.note)
      fieldIssue('note', 'A checkout note is required');
    const timestamp = dto.checkout_at ? new Date(dto.checkout_at) : new Date();
    if (dto.expected_checkin && dto.expected_checkin < timestamp.toISOString().slice(0, 10)) {
      fieldIssue('expected_checkin', 'The expected check-in precedes checkout');
    }
    const target = await this.target(tx, asset, scope, dto.target_type, dto.target_id);
    if (
      dto.target_type !== 'location' &&
      !this.fmcs.compatible(scope, asset.companyId, target.companyIds)
    ) {
      fieldIssue('target_id', 'This target is outside the asset company scope');
    }
    if (dto.sign_in_place && (dto.target_type !== 'user' || !category?.requireAcceptance)) {
      fieldIssue(
        'sign_in_place',
        'In-person signing is available for user checkouts requiring acceptance',
      );
    }
    const entries = await this.hardware.assetFields(tx, asset.modelId);
    const customFields = await this.validation.prepare(tx, {
      entries,
      submitted: dto.custom_fields,
      existing: asset.customFields,
      assetId: asset.id,
      mode: 'checkout',
    });
    if (dto.target_type === 'user')
      await this.propagateLicenseSeats(tx, asset, dto.target_id, user.id);
    await tx
      .update(assets)
      .set({
        assignedTo: dto.target_id,
        assignedType: dto.target_type,
        accepted: null,
        locationId: target.locationId,
        lastCheckout: timestamp,
        expectedCheckin: dto.expected_checkin ?? null,
        name: dto.name ?? asset.name,
        customFields,
        checkoutCounter: asset.checkoutCounter + 1,
        updatedAt: new Date(),
      })
      .where(eq(assets.id, asset.id));

    let acceptanceId: number | null = null;
    let eula: string | null = null;
    if (dto.target_type === 'user' && category?.requireAcceptance) {
      eula = category.useDefaultEula ? (config?.defaultEulaText ?? null) : category.eulaText;
      const [acceptance] = await tx
        .insert(checkoutAcceptances)
        .values({
          checkoutableType: 'asset',
          checkoutableId: asset.id,
          assignedToId: dto.target_id,
          storedEula: eula,
          alertOnResponseId: user.id,
          alertOnResponse: category.alertOnResponse,
          signInPlace: dto.sign_in_place ?? false,
        })
        .returning({ id: checkoutAcceptances.id });
      acceptanceId = acceptance!.id;
    }
    const [log] = await tx
      .insert(actionLogs)
      .values({
        actionType: 'checkout',
        itemType: 'asset',
        itemId: asset.id,
        createdBy: user.id,
        companyId: asset.companyId,
        targetType: dto.target_type,
        targetId: dto.target_id,
        locationId: target.locationId,
        expectedCheckin: dto.expected_checkin,
        note: dto.note,
        actionDate: timestamp,
        actionSource: 'api',
        acceptedId: acceptanceId,
        storedEula: eula,
      })
      .returning({ id: actionLogs.id });
    const assetLabel = asset.assetTag ?? `#${asset.id}`;
    const acceptUrl = acceptanceId
      ? '\nReview and respond: ' +
        new URL(`/account/accept/${acceptanceId}`, this.env.get('APP_URL', { infer: true })).href
      : '';
    await this.mail.enqueue(
      tx,
      target.email,
      `Asset checked out: ${assetLabel}`,
      `Asset ${assetLabel} was assigned to you.${acceptUrl}` +
        this.emailFields(entries, customFields, user),
    );
    return {
      id: asset.id,
      action_log_id: log!.id,
      acceptance_id: acceptanceId,
      sign_in_place: dto.sign_in_place ?? false,
      location_id: target.locationId,
    };
  }

  async checkin(selector: number | string, body: unknown, user: AuthenticatedUserContext) {
    if (!permitsKey(user, 'assets.checkin'))
      throw new ForbiddenException('Check-in permission required');
    const dto = parse(AssetCheckinInputSchema, body);
    return inventoryWrite(this.db, async (tx) => {
      const scope = await this.fmcs.resolve(user, tx);
      const asset = await this.hardware.find(tx, scope, selector, { lock: true });
      const { config, category } = await this.workflowSettings(tx, asset);
      const alreadyReturned = asset.assignedTo === null;
      if (
        alreadyReturned &&
        dto.status_id === undefined &&
        dto.location_id === undefined &&
        dto.name === undefined &&
        !dto.clear_name
      ) {
        throw new ConflictException('The asset is already checked in');
      }
      if (!alreadyReturned && config?.requireCheckinoutNotes && !dto.note) {
        fieldIssue('note', 'A check-in note is required');
      }
      if (dto.status_id !== undefined && !(await this.hardware.status(tx, dto.status_id))) {
        fieldIssue('status_id', 'The status label is unavailable');
      }
      if (dto.update_default_location && dto.location_id === undefined) {
        fieldIssue('location_id', 'Choose a home location');
      }
      const locationId =
        dto.location_id !== undefined
          ? dto.location_id
          : alreadyReturned
            ? asset.locationId
            : asset.rtdLocationId;
      if (locationId !== null) await this.checkLocation(tx, scope, locationId, asset.companyId);
      const entries = await this.hardware.assetFields(tx, asset.modelId);
      const customFields = await this.validation.prepare(tx, {
        entries,
        submitted: dto.custom_fields,
        existing: asset.customFields,
        assetId: asset.id,
        mode: 'checkin',
      });
      const date = dto.checkin_at ? new Date(dto.checkin_at) : new Date();
      if (!alreadyReturned && asset.lastCheckout && date < asset.lastCheckout) {
        fieldIssue('checkin_at', 'Check-in cannot precede checkout');
      }
      const changes = {
        locationId,
        statusId: dto.status_id,
        name: dto.clear_name ? null : dto.name,
        rtdLocationId: dto.update_default_location ? locationId : undefined,
        customFields,
        updatedAt: new Date(),
      };
      if (alreadyReturned) {
        await tx.update(assets).set(changes).where(eq(assets.id, asset.id));
        return success({ id: asset.id, checked_in: false }, 'Asset record updated');
      }
      await tx
        .update(checkoutAcceptances)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(pendingAcceptance('asset', asset.id));
      await tx
        .update(assets)
        .set({
          ...changes,
          assignedTo: null,
          assignedType: null,
          accepted: null,
          expectedCheckin: null,
          lastCheckin: date,
          checkinCounter: asset.checkinCounter + 1,
        })
        .where(eq(assets.id, asset.id));
      await tx.insert(actionLogs).values({
        actionType: 'checkin from',
        itemType: 'asset',
        itemId: asset.id,
        createdBy: user.id,
        companyId: asset.companyId,
        locationId,
        targetType: asset.assignedType,
        targetId: asset.assignedTo,
        note: dto.note,
        actionDate: date,
        actionSource: 'api',
      });
      if (category?.checkinEmail && asset.assignedType === 'user' && asset.assignedTo !== null) {
        const [assignee] = await tx
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, asset.assignedTo))
          .limit(1);
        const label = asset.assetTag ?? `#${asset.id}`;
        await this.mail.enqueue(
          tx,
          assignee?.email,
          `Asset checked in: ${label}`,
          `Asset ${label} was checked in.` + this.emailFields(entries, customFields, user),
        );
      }
      return success({ id: asset.id, checked_in: true }, 'Asset checked in');
    });
  }

  private async workflowSettings(tx: InventoryTransaction, asset: Hardware) {
    const [config] = await tx.select().from(settings).orderBy(settings.id).limit(1);
    if (asset.modelId === null) return { config, category: null };
    const [record] = await tx
      .select({ category: categories })
      .from(models)
      .innerJoin(categories, eq(categories.id, models.categoryId))
      .where(and(eq(models.id, asset.modelId), isNull(categories.deletedAt)))
      .limit(1);
    return { config, category: record?.category ?? null };
  }

  private async checkLocation(
    tx: InventoryTransaction,
    scope: FmcsScope,
    id: number,
    companyId: number | null,
  ) {
    const [row] = await tx
      .select()
      .from(locations)
      .where(
        and(
          eq(locations.id, id),
          isNull(locations.deletedAt),
          this.fmcs.predicate(scope, 'locations', locations.id, locations.companyId),
        ),
      )
      .limit(1)
      .for('update');
    if (!row) fieldIssue('location_id', 'The location is unavailable');
    if (
      scope.scopeLocations &&
      !this.fmcs.compatible(scope, companyId, row.companyId === null ? [] : [row.companyId])
    ) {
      fieldIssue('location_id', 'The location is outside the asset company scope');
    }
    return row;
  }

  private async target(
    tx: InventoryTransaction,
    asset: Hardware,
    scope: FmcsScope,
    type: CheckoutTargetType,
    id: number,
  ) {
    if (type === 'location') {
      const location = await this.checkLocation(tx, scope, id, asset.companyId);
      return {
        companyIds: location.companyId === null ? [] : [location.companyId],
        locationId: location.id,
        email: null,
      };
    }
    if (type === 'user') {
      const [user] = await tx
        .select()
        .from(users)
        .where(
          and(
            eq(users.id, id),
            or(eq(users.activated, true), eq(users.inventoryOnly, true)),
            isNull(users.deletedAt),
            this.fmcs.predicate(scope, 'users', users.id),
          ),
        )
        .limit(1)
        .for('update');
      if (!user) throw new NotFoundException('Checkout target not found');
      const companyIds = (
        await tx
          .select({ id: companyUser.companyId })
          .from(companyUser)
          .where(eq(companyUser.userId, id))
      ).map(({ id: company }) => company);
      return { companyIds, locationId: user.locationId, email: user.email };
    }
    const target = await this.hardware.find(tx, scope, id, { lock: true });
    const visited = new Set([asset.id]);
    let next: Hardware | undefined = target;
    while (next) {
      if (visited.has(next.id)) fieldIssue('target_id', 'Asset assignment cannot contain cycles');
      visited.add(next.id);
      if (next.assignedType !== 'asset' || next.assignedTo === null) break;
      const [parent] = await tx
        .select()
        .from(assets)
        .where(eq(assets.id, next.assignedTo))
        .limit(1)
        .for('update');
      next = parent;
    }
    return {
      companyIds: target.companyId === null ? [] : [target.companyId],
      locationId: target.locationId ?? target.rtdLocationId,
      email: null,
    };
  }

  private async propagateLicenseSeats(
    tx: InventoryTransaction,
    asset: Hardware,
    holder: number,
    actor: number,
  ) {
    const rows = await tx
      .select({ seat: licenseSeats, license: licenses })
      .from(licenseSeats)
      .innerJoin(licenses, eq(licenses.id, licenseSeats.licenseId))
      .where(
        and(
          eq(licenseSeats.assetId, asset.id),
          isNull(licenseSeats.deletedAt),
          isNull(licenses.deletedAt),
        ),
      )
      .orderBy(licenseSeats.id)
      .for('update');
    for (const { seat, license } of rows) {
      const hasOtherUser = seat.assignedTo !== null && seat.assignedTo !== holder;
      if (seat.unreassignableSeat || (hasOtherUser && !license.reassignable)) {
        throw new ConflictException('An attached license seat cannot be reassigned');
      }
    }
    for (const { seat } of rows) {
      if (seat.assignedTo === holder) continue;
      if (seat.assignedTo !== null) {
        await tx
          .update(checkoutAcceptances)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              pendingAcceptance('license_seat', seat.id),
              eq(checkoutAcceptances.assignedToId, seat.assignedTo),
            ),
          );
        await tx.insert(actionLogs).values({
          actionType: 'checkin from',
          itemType: 'license_seat',
          itemId: seat.id,
          targetType: 'user',
          targetId: seat.assignedTo,
          createdBy: actor,
          companyId: asset.companyId,
          actionSource: 'api',
          actionDate: new Date(),
        });
      }
      await tx
        .update(licenseSeats)
        .set({ assignedTo: holder, updatedAt: new Date() })
        .where(eq(licenseSeats.id, seat.id));
    }
  }

  private emailFields(
    entries: Awaited<ReturnType<HardwareService['assetFields']>>,
    data: Record<string, unknown>,
    user: AuthenticatedUserContext,
  ) {
    return Object.entries(this.validation.serialize(entries, data, user, 'email'))
      .filter(([, field]) => field.value != null)
      .map(
        ([name, field]) =>
          `\n${name}: ${Array.isArray(field.value) ? field.value.join(', ') : String(field.value)}`,
      )
      .join('');
  }
}

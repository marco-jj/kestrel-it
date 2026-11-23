import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  RequestableInputSchema,
  type AuthenticatedUserContext,
  type DatatableQuery,
} from '@kestrel-it/shared';
import { and, count, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { permitsKey } from '../../common/guards/permissions.guard.js';
import type { EnvConfig } from '../../config/env.schema.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import {
  actionLogs,
  assets,
  checkoutRequests,
  models,
  settings,
  users,
} from '../../db/schema/index.js';
import { AssetCheckoutService } from './asset-checkout.service.js';
import { CustomFieldsValidationService, fieldIssue } from './custom-fields-validation.service.js';
import { FmcsScopeService, type FmcsScope } from './fmcs-scope.service.js';
import { HardwareService } from './hardware.service.js';
import { InventoryMailService } from './inventory-mail.service.js';
import {
  contains,
  datatable,
  inventoryWrite,
  pageOffset,
  parse,
  success,
  type InventoryTransaction,
} from './inventory-queries.js';

type RequestableKind = 'asset' | 'model';
type CheckoutRequest = typeof checkoutRequests.$inferSelect;

@Injectable()
export class CheckoutRequestsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(ConfigService) private readonly env: ConfigService<EnvConfig, true>,
    @Inject(FmcsScopeService) private readonly fmcs: FmcsScopeService,
    @Inject(HardwareService) private readonly hardware: HardwareService,
    @Inject(CustomFieldsValidationService) private readonly fields: CustomFieldsValidationService,
    @Inject(AssetCheckoutService) private readonly checkout: AssetCheckoutService,
    @Inject(InventoryMailService) private readonly mail: InventoryMailService,
  ) {}

  async catalog(
    kind: RequestableKind,
    query: DatatableQuery,
    user: AuthenticatedUserContext,
    url: string,
  ) {
    this.requireRequestable(user);
    const scope = await this.fmcs.resolve(user);
    if (kind === 'model') {
      const visibleModels = and(
        eq(models.requestable, true),
        isNull(models.deletedAt),
        query.search
          ? or(contains(models.name, query.search), contains(models.modelNumber, query.search))
          : undefined,
      );
      const [[total], rows] = await Promise.all([
        this.db.select({ value: count() }).from(models).where(visibleModels),
        this.db
          .select({
            id: models.id,
            name: models.name,
            model_number: models.modelNumber,
            requested: this.hasRequest(user.id, 'model', models.id),
          })
          .from(models)
          .where(visibleModels)
          .orderBy(models.name, models.id)
          .limit(query.limit)
          .offset(pageOffset(query)),
      ]);
      return datatable(
        total!.value,
        rows.map(({ requested, ...row }) => ({
          ...row,
          available_actions: { request: !requested, cancel: requested },
        })),
        query,
        url,
      );
    }
    const visibleAssets = and(
      eq(assets.requestable, true),
      this.hardware.visible(scope),
      query.search
        ? or(contains(assets.name, query.search), contains(assets.assetTag, query.search))
        : undefined,
    );
    const [[total], rows] = await Promise.all([
      this.db.select({ value: count() }).from(assets).where(visibleAssets),
      this.db
        .select({
          id: assets.id,
          name: assets.name,
          asset_tag: assets.assetTag,
          customFields: assets.customFields,
          fieldsetId: models.fieldsetId,
          requested: this.hasRequest(user.id, 'asset', assets.id),
        })
        .from(assets)
        .leftJoin(models, eq(models.id, assets.modelId))
        .where(visibleAssets)
        .orderBy(assets.assetTag, assets.id)
        .limit(query.limit)
        .offset(pageOffset(query)),
    ]);
    const sets = [...new Set(rows.map(({ fieldsetId }) => fieldsetId))];
    const entries = new Map(
      await Promise.all(
        sets.map(async (id) => [id, await this.fields.fields(this.db, id)] as const),
      ),
    );
    return datatable(
      total!.value,
      rows.map(({ requested, fieldsetId, customFields, ...row }) => ({
        ...row,
        custom_fields: this.fields.serialize(
          entries.get(fieldsetId) ?? [],
          customFields,
          user,
          'request',
        ),
        available_actions: { request: !requested, cancel: requested },
      })),
      query,
      url,
    );
  }

  private hasRequest(
    userId: number,
    kind: RequestableKind,
    item: typeof assets.id | typeof models.id,
  ) {
    return sql<boolean>`exists (select 1 from ${checkoutRequests} where ${and(
      eq(checkoutRequests.userId, userId),
      eq(checkoutRequests.requestableType, kind),
      eq(checkoutRequests.requestableId, item),
      this.pending(),
    )})`;
  }

  private pending() {
    return and(isNull(checkoutRequests.deletedAt), eq(checkoutRequests.state, 'pending'));
  }

  async list(query: DatatableQuery, user: AuthenticatedUserContext, url: string, staff = false) {
    if (staff && !permitsKey(user, 'assets.checkout'))
      throw new ForbiddenException('Checkout permission required');
    const scope = await this.fmcs.resolve(user);
    const supported = or(
      eq(checkoutRequests.requestableType, 'asset'),
      eq(checkoutRequests.requestableType, 'model'),
    );
    const visibility = or(
      and(
        eq(checkoutRequests.requestableType, 'asset'),
        sql`${assets.id} is not null`,
        this.hardware.visible(scope),
      ),
      and(
        eq(checkoutRequests.requestableType, 'model'),
        sql`${models.id} is not null`,
        isNull(models.deletedAt),
      ),
    );
    const filters = and(
      supported,
      isNull(checkoutRequests.deletedAt),
      visibility,
      staff
        ? and(
            this.pending(),
            this.fmcs.predicate(scope, 'users', users.id),
            isNull(users.deletedAt),
            eq(users.activated, true),
          )
        : eq(checkoutRequests.userId, user.id),
      query.search
        ? or(
            contains(checkoutRequests.notes, query.search),
            contains(assets.assetTag, query.search),
            contains(assets.name, query.search),
            contains(models.name, query.search),
          )
        : undefined,
    );
    const assetJoin = and(
      eq(checkoutRequests.requestableType, 'asset'),
      eq(checkoutRequests.requestableId, assets.id),
    );
    const modelJoin = and(
      eq(checkoutRequests.requestableType, 'model'),
      eq(checkoutRequests.requestableId, models.id),
    );
    const [[total], rows] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(checkoutRequests)
        .innerJoin(users, eq(checkoutRequests.userId, users.id))
        .leftJoin(assets, assetJoin)
        .leftJoin(models, modelJoin)
        .where(filters),
      this.db
        .select({
          request: checkoutRequests,
          tag: assets.assetTag,
          assetName: assets.name,
          modelName: models.name,
          username: users.username,
        })
        .from(checkoutRequests)
        .innerJoin(users, eq(checkoutRequests.userId, users.id))
        .leftJoin(assets, assetJoin)
        .leftJoin(models, modelJoin)
        .where(filters)
        .orderBy(desc(checkoutRequests.id))
        .limit(query.limit)
        .offset(pageOffset(query)),
    ]);
    return datatable(
      total!.value,
      rows.map(({ request, tag, assetName, modelName, username }) => ({
        ...this.present(request),
        item:
          [tag, assetName ?? modelName].filter(Boolean).join(' — ') || `#${request.requestableId}`,
        requester: username,
        available_actions: {
          cancel: request.state === 'pending',
          checkout: staff && request.state === 'pending',
        },
      })),
      query,
      url,
    );
  }

  async create(type: RequestableKind, id: number, input: unknown, user: AuthenticatedUserContext) {
    this.requireRequestable(user);
    const dto = parse(RequestableInputSchema, input ?? {});
    return inventoryWrite(this.db, async (tx) => {
      const scope = await this.fmcs.resolve(user, tx);
      const item = await this.item(tx, scope, type, id);
      if (!item.requestable) fieldIssue('requestable_id', 'This item is unavailable for requests');
      const [duplicate] = await tx
        .select({ id: checkoutRequests.id })
        .from(checkoutRequests)
        .where(
          and(
            eq(checkoutRequests.requestableType, type),
            eq(checkoutRequests.requestableId, id),
            eq(checkoutRequests.userId, user.id),
            this.pending(),
          ),
        )
        .limit(1);
      if (duplicate) throw new ConflictException('A request for this item is already pending');
      const [record] = await tx
        .insert(checkoutRequests)
        .values({
          userId: user.id,
          requestableType: type,
          requestableId: id,
          startDate: dto.start_date,
          endDate: dto.end_date,
          notes: dto.notes,
        })
        .returning();
      if (type === 'asset') await this.bump(tx, id, 1);
      await this.log(tx, record!, user.id, 'requested', item.companyId);
      await this.notify(tx, 'New checkout request', item.label, user.username);
      return success(this.present(record!), 'Checkout request submitted');
    });
  }

  async cancelByItem(type: RequestableKind, id: number, user: AuthenticatedUserContext) {
    return inventoryWrite(this.db, async (tx) => {
      const [row] = await tx
        .select()
        .from(checkoutRequests)
        .where(
          and(
            eq(checkoutRequests.requestableType, type),
            eq(checkoutRequests.requestableId, id),
            eq(checkoutRequests.userId, user.id),
            this.pending(),
          ),
        )
        .limit(1)
        .for('update');
      if (!row) throw new NotFoundException('Active request not found');
      return this.cancelInTransaction(tx, row, user, false);
    });
  }

  async cancel(id: number, user: AuthenticatedUserContext, staff = false) {
    if (staff && !permitsKey(user, 'assets.checkout'))
      throw new ForbiddenException('Checkout permission required');
    return inventoryWrite(this.db, async (tx) => {
      const row = await this.find(tx, id, staff ? undefined : user.id);
      return this.cancelInTransaction(tx, row, user, staff);
    });
  }

  private async cancelInTransaction(
    tx: InventoryTransaction,
    row: CheckoutRequest,
    user: AuthenticatedUserContext,
    staff: boolean,
  ) {
    if (row.state !== 'pending')
      throw new ConflictException('Only pending requests can be canceled');
    const type = this.kind(row);
    const scope = await this.fmcs.resolve(user, tx);
    const item = await this.item(tx, scope, type, row.requestableId);
    if (staff) await this.visibleUser(tx, scope, row.userId);
    const date = new Date();
    const [saved] = await tx
      .update(checkoutRequests)
      .set({ state: 'canceled', canceledAt: date, updatedAt: date })
      .where(eq(checkoutRequests.id, row.id))
      .returning();
    if (type === 'asset') await this.bump(tx, row.requestableId, -1);
    await this.log(tx, saved!, user.id, 'canceled', item.companyId);
    await this.notify(tx, 'Checkout request canceled', item.label, user.username);
    return success(this.present(saved!), 'Checkout request canceled');
  }

  async fulfill(id: number, input: unknown, user: AuthenticatedUserContext) {
    if (!permitsKey(user, 'assets.checkout'))
      throw new ForbiddenException('Checkout permission required');
    const dto = parse(
      z
        .object({
          asset_id: z.coerce.number().int().positive().max(2_147_483_647).optional(),
          expected_checkin: z.string().date().nullable().optional(),
          note: z.string().trim().max(10_000).optional(),
        })
        .strict(),
      input ?? {},
    );
    return inventoryWrite(this.db, async (tx) => {
      const row = await this.find(tx, id);
      if (row.state !== 'pending')
        throw new ConflictException('Only pending requests can be fulfilled');
      const type = this.kind(row);
      const scope = await this.fmcs.resolve(user, tx);
      await this.item(tx, scope, type, row.requestableId);
      await this.visibleUser(tx, scope, row.userId);
      const assetId = type === 'asset' ? row.requestableId : dto.asset_id;
      if (
        !assetId ||
        (type === 'asset' && dto.asset_id !== undefined && dto.asset_id !== assetId)
      ) {
        fieldIssue('asset_id', 'Choose the requested asset or an asset of the requested model');
      }
      if (type === 'model') {
        const selected = await this.hardware.find(tx, scope, assetId, { lock: true });
        if (selected.modelId !== row.requestableId)
          fieldIssue('asset_id', 'The asset is not of the requested model');
      }
      const checkout = await this.checkout.checkoutInTransaction(
        tx,
        assetId,
        {
          target_type: 'user',
          target_id: row.userId,
          expected_checkin: dto.expected_checkin,
          note: dto.note,
        },
        user,
        scope,
      );
      const date = new Date();
      const [saved] = await tx
        .update(checkoutRequests)
        .set({
          state: 'fulfilled',
          fulfilledAt: date,
          fulfilledBy: user.id,
          fulfilledQuantity: 1,
          checkoutActionlogId: checkout.action_log_id,
          updatedAt: date,
        })
        .where(eq(checkoutRequests.id, id))
        .returning();
      if (type === 'asset') await this.bump(tx, row.requestableId, -1);
      return success(
        { ...this.present(saved!), asset_id: checkout.id },
        'Checkout request fulfilled',
      );
    });
  }

  private async visibleUser(tx: InventoryTransaction, scope: FmcsScope, id: number) {
    const [row] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, id),
          isNull(users.deletedAt),
          this.fmcs.predicate(scope, 'users', users.id),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Checkout request not found');
  }

  private async find(tx: InventoryTransaction, id: number, owner?: number) {
    const [row] = await tx
      .select()
      .from(checkoutRequests)
      .where(
        and(
          eq(checkoutRequests.id, id),
          isNull(checkoutRequests.deletedAt),
          owner === undefined ? undefined : eq(checkoutRequests.userId, owner),
        ),
      )
      .limit(1)
      .for('update');
    if (!row) throw new NotFoundException('Checkout request not found');
    return row;
  }

  private kind(row: CheckoutRequest): RequestableKind {
    if (row.requestableType !== 'asset' && row.requestableType !== 'model') {
      throw new NotFoundException('Checkout request not found');
    }
    return row.requestableType;
  }

  private async item(
    tx: InventoryTransaction,
    scope: FmcsScope,
    type: RequestableKind,
    id: number,
  ) {
    if (type === 'asset') {
      const row = await this.hardware.find(tx, scope, id, { lock: true });
      return {
        companyId: row.companyId,
        requestable: row.requestable,
        label: row.assetTag ?? `Asset #${id}`,
      };
    }
    const [row] = await tx
      .select()
      .from(models)
      .where(and(eq(models.id, id), isNull(models.deletedAt)))
      .limit(1)
      .for('update');
    if (!row) throw new NotFoundException('Requestable model not found');
    return { companyId: null, requestable: row.requestable, label: row.name };
  }

  private async bump(tx: InventoryTransaction, id: number, amount: number) {
    await tx
      .update(assets)
      .set({ requestsCounter: sql`greatest(0, ${assets.requestsCounter} + ${amount})` })
      .where(eq(assets.id, id));
  }

  private async log(
    tx: InventoryTransaction,
    row: CheckoutRequest,
    actor: number,
    action: 'requested' | 'canceled',
    companyId: number | null,
  ) {
    await tx.insert(actionLogs).values({
      createdBy: actor,
      actionType: action,
      itemType: row.requestableType,
      itemId: row.requestableId,
      companyId,
      targetId: row.userId,
      targetType: 'user',
      actionSource: 'api',
      actionDate: new Date(),
      note: row.notes,
    });
  }

  private async notify(
    tx: InventoryTransaction,
    subject: string,
    label: string,
    requester: string,
  ) {
    const [config] = await tx
      .select({ enabled: settings.alertsEnabled, recipient: settings.alertEmail })
      .from(settings)
      .orderBy(settings.id)
      .limit(1);
    if (!config?.enabled) return;
    const url = new URL('/requests', this.env.get('APP_URL', { infer: true }));
    await this.mail.enqueue(tx, config.recipient, subject, `${label} — ${requester}\n${url.href}`);
  }

  private requireRequestable(user: AuthenticatedUserContext) {
    if (!permitsKey(user, 'assets.view.requestable'))
      throw new ForbiddenException('Requestable inventory permission required');
  }

  private present(row: CheckoutRequest) {
    return {
      id: row.id,
      requestable_type: row.requestableType,
      requestable_id: row.requestableId,
      state: row.state,
      start_date: row.startDate,
      end_date: row.endDate,
      notes: row.notes,
      requested_at: row.createdAt.toISOString(),
      fulfilled_at: row.fulfilledAt?.toISOString() ?? null,
    };
  }
}

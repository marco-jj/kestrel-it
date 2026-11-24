import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import {
  AcceptanceResponseSchema,
  type AuthenticatedUserContext,
  type DatatableQuery,
  type StorageBucketCategory,
  type PolymorphicItemType,
} from '@kestrel-it/shared';
import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { permitsKey } from '../../common/guards/permissions.guard.js';
import { STORAGE_PROVIDER, type StorageProvider } from '../../common/storage/storage.interface.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import {
  actionLogs,
  accessories,
  accessoriesCheckout,
  assets,
  consumables,
  consumablesUsers,
  licenses,
  licenseSeats,
  checkoutAcceptances,
  models,
  settings,
  users,
} from '../../db/schema/index.js';
import { acceptancePdf, signaturePng } from './acceptance-artifacts.js';
import { fieldIssue } from './custom-fields-validation.service.js';
import { FmcsScopeService, type FmcsScope } from './fmcs-scope.service.js';
import { InventoryMailService } from './inventory-mail.service.js';
import {
  datatable,
  inventoryWrite,
  pageOffset,
  parse,
  success,
  type InventoryDatabase,
} from './inventory-queries.js';

type Acceptance = typeof checkoutAcceptances.$inferSelect;
type StoredArtifact = { category: StorageBucketCategory; key: string };

@Injectable()
export class CheckoutAcceptancesService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(FmcsScopeService) private readonly fmcs: FmcsScopeService,
    @Inject(InventoryMailService) private readonly mail: InventoryMailService,
  ) {}

  async list(query: DatatableQuery, user: AuthenticatedUserContext, url: string, history = false) {
    const scope = await this.fmcs.resolve(user);
    const own = eq(checkoutAcceptances.assignedToId, user.id);
    const delegated = permitsKey(user, 'assets.checkout')
      ? and(eq(checkoutAcceptances.checkoutableType, 'asset'),
          eq(checkoutAcceptances.alertOnResponseId, user.id), eq(checkoutAcceptances.signInPlace, true))
      : undefined;
    const filter = and(isNull(checkoutAcceptances.deletedAt), history ? own : or(own, delegated),
      history ? or(isNotNull(checkoutAcceptances.acceptedAt), isNotNull(checkoutAcceptances.declinedAt))
        : and(isNull(checkoutAcceptances.acceptedAt), isNull(checkoutAcceptances.declinedAt)));
    const source = this.subjects(scope, !history);
    const from = sql`from ${checkoutAcceptances} join lateral (${source}) as item on true where ${filter}`;
    const [totals, rows] = await Promise.all([
      this.db.execute<{ total: number }>(sql`select count(*)::int as total ${from}`),
      this.db.execute<{
        id: number; asset_id: number; asset_tag: string | null; asset_name: string | null;
        item_type: PolymorphicItemType; state: string; accepted_at: string | null;
        declined_at: string | null; created_at: string; has_eula: boolean; has_signature: boolean;
      }>(sql`select ${checkoutAcceptances.id}, item.inventory_id as asset_id, item.tag as asset_tag, item.name as asset_name,
        item.item_type, case when ${checkoutAcceptances.acceptedAt} is not null then 'accepted'
          when ${checkoutAcceptances.declinedAt} is not null then 'declined' else 'pending' end as state,
        ${checkoutAcceptances.acceptedAt}, ${checkoutAcceptances.declinedAt}, ${checkoutAcceptances.createdAt},
        ${checkoutAcceptances.storedEulaFile} is not null as has_eula,
        ${checkoutAcceptances.signatureFilename} is not null as has_signature
        ${from} order by ${checkoutAcceptances.id} desc limit ${query.limit} offset ${pageOffset(query)}`),
    ]);
    const stamp = (value: string | null) => value === null ? null : new Date(value).toISOString();
    return datatable(totals[0]!.total, rows.map((row) => ({ ...row,
      accepted_at: stamp(row.accepted_at), declined_at: stamp(row.declined_at), created_at: stamp(row.created_at),
    })), query, url);
  }

  subjects(scope: FmcsScope, pending: boolean) {
    const acceptance = checkoutAcceptances;
    const subjectId = acceptance.checkoutableId;
    const owner = acceptance.assignedToId;
    const scopeFor = (table: typeof accessories | typeof consumables | typeof licenses) =>
      this.fmcs.predicate(scope, 'inventory', table.id, table.companyId) ?? sql`true`;
    const assignment = (type: 'accessory' | 'consumable') => {
      const inventory = type === 'accessory' ? accessories : consumables;
      const active = type === 'accessory' ? sql`
        from ${accessoriesCheckout} where ${accessoriesCheckout.accessoryId} = ${inventory.id}
        and ${accessoriesCheckout.id}::text = ${actionLogs.logMeta}->>'assignment_id'
        and ${accessoriesCheckout.assignedType} = 'user' and ${accessoriesCheckout.assignedTo} = ${owner}`
        : sql`from ${consumablesUsers} where ${consumablesUsers.consumableId} = ${inventory.id}
        and ${consumablesUsers.id}::text = ${actionLogs.logMeta}->>'assignment_id'
        and ${consumablesUsers.assignedTo} = ${owner} and ${consumablesUsers.consumedAt} is null`;
      return sql`select ${inventory.id}, ${inventory.name}, null::text, ${inventory.companyId}, null::int,
        null::int, null::text, ${type}::text from ${inventory}
        where ${acceptance.checkoutableType} = ${type} and ${inventory.id} = ${subjectId}
          and ${scopeFor(inventory)} ${pending ? sql`and ${inventory.deletedAt} is null and exists (
          select 1 from ${actionLogs} where ${actionLogs.acceptedId} = ${acceptance.id}
            and ${actionLogs.itemType} = ${type} and ${actionLogs.itemId} = ${inventory.id}
            and ${actionLogs.actionType} = 'checkout' and exists (select 1 ${active})
        )` : sql.empty()}`;
    };
    return sql`
      select ${assets.id} as inventory_id, ${assets.name}, ${assets.assetTag} as tag, ${assets.companyId},
        ${assets.locationId}, ${assets.modelId}, ${assets.serial}, 'asset'::text as item_type
      from ${assets} where ${acceptance.checkoutableType} = 'asset' and ${assets.id} = ${subjectId}
        and ${this.fmcs.predicate(scope, 'hardware', assets.id, assets.companyId) ?? sql`true`}
        ${pending ? sql`and ${assets.deletedAt} is null and ${assets.assignedType} = 'user'
          and ${assets.assignedTo} = ${owner}` : sql.empty()}
      union all select ${licenses.id}, ${licenses.name}, null::text, ${licenses.companyId}, null::int, null::int,
        null::text, 'license'::text from ${licenseSeats} join ${licenses} on ${licenses.id} = ${licenseSeats.licenseId}
      where ${acceptance.checkoutableType} = 'license_seat' and ${licenseSeats.id} = ${subjectId}
        and ${scopeFor(licenses)} ${pending ? sql`and ${licenseSeats.deletedAt} is null and
          ${licenses.deletedAt} is null and ${licenseSeats.assignedTo} = ${owner}` : sql.empty()}
      union all ${assignment('accessory')}
      union all ${assignment('consumable')}
    `;
  }

  async get(id: number, user: AuthenticatedUserContext) {
    const scope = await this.fmcs.resolve(user);
    const { asset, row } = await this.access(this.db, scope, id, user);
    return {
      ...this.present(row),
      asset_id: asset.id,
      item_type: asset.itemType,
      asset_tag: asset.assetTag,
      asset_name: asset.name,
      eula: row.storedEula,
      requires_signature: await this.signatureRequired(this.db),
    };
  }

  async respond(id: number, input: unknown, user: AuthenticatedUserContext) {
    const dto = parse(AcceptanceResponseSchema, input);
    const signature = dto.signature ? signaturePng(dto.signature) : null;
    const isAccepting = dto.decision === 'accept';
    const today = new Date();
    const note = dto.note ?? null;
    const written: StoredArtifact[] = [];
    let signatureFilename: string | null = null;
    let storedEulaFile: string | null = null;
    let finalizing = false;
    try {
      if (isAccepting) {
        const { asset, row, assignee } = await this.pendingResponse(this.db, id, user);
        if (!signature && (await this.signatureRequired(this.db)))
          fieldIssue('signature', 'A signature is required');
        const [model] =
          asset.modelId === null
            ? []
            : await this.db
                .select({ name: models.name })
                .from(models)
                .where(eq(models.id, asset.modelId))
                .limit(1);
        const pdf = await acceptancePdf({
          tag: asset.assetTag ?? `#${asset.id}`,
          name: asset.name ?? '',
          model: model?.name ?? '',
          serial: asset.serial ?? '',
          assignee:
            assignee.displayName ??
            ([assignee.firstName, assignee.lastName].filter(Boolean).join(' ') ||
              assignee.username),
          eula: row.storedEula,
          acceptedAt: today,
          signature,
          note,
        });
        const key = `${row.id}/${randomUUID()}`;
        if (signature) {
          signatureFilename = key + '.png';
          written.push({ category: 'signatures', key: signatureFilename });
          await this.storage.putObject('signatures', signatureFilename, signature, 'image/png');
        }
        storedEulaFile = key + '.pdf';
        written.push({ category: 'eulas', key: storedEulaFile });
        await this.storage.putObject('eulas', storedEulaFile, pdf, 'application/pdf');
      }

      finalizing = true;
      return await inventoryWrite(this.db, async (tx) => {
        const { asset, row, assignee } = await this.pendingResponse(tx, id, user, true);
        if (isAccepting && !signature && (await this.signatureRequired(tx)))
          fieldIssue('signature', 'A signature is required');
        const label = asset.assetTag ?? `#${asset.id}`;
        await tx
          .update(checkoutAcceptances)
          .set({
            acceptedAt: isAccepting ? today : null,
            declinedAt: isAccepting ? null : today,
            note,
            signatureFilename,
            storedEulaFile,
            updatedAt: today,
          })
          .where(eq(checkoutAcceptances.id, id));
        if (asset.itemType === 'asset') await tx
          .update(assets)
          .set({ accepted: isAccepting ? true : null, updatedAt: today })
          .where(eq(assets.id, asset.id));
        const action = isAccepting ? 'accepted' : 'declined';
        await tx.insert(actionLogs).values({
          actionType: action,
          itemType: asset.itemType,
          itemId: asset.id,
          createdBy: user.id,
          targetType: 'user',
          targetId: assignee.id,
          companyId: asset.companyId,
          locationId: asset.locationId,
          acceptedId: id,
          note,
          actionDate: today,
          actionSource: 'api',
        });
        if (!isAccepting || row.alertOnResponse) {
          const [operator] =
            row.alertOnResponseId === null
              ? []
              : await tx
                  .select({ email: users.email })
                  .from(users)
                  .where(and(eq(users.id, row.alertOnResponseId), isNull(users.deletedAt)))
                  .limit(1);
          await this.mail.enqueue(
            tx,
            operator?.email,
            `Asset acceptance ${action}: ${label}`,
            `The checkout acceptance for asset ${label} was ${action}.`,
            isAccepting ? 'acceptance.accepted' : 'acceptance.declined',
          );
          if (isAccepting)
            await this.mail.enqueue(
              tx,
              assignee.email,
              `Asset acceptance confirmed: ${label}`,
              `Your acceptance for asset ${label} was recorded.`,
              'acceptance.receipt',
            );
        }
        return success({ id, state: action, has_eula: storedEulaFile !== null });
      });
    } catch (error) {
      if (written.length) await this.removeUnreferencedArtifacts(id, written, finalizing);
      throw error;
    }
  }

  private async pendingResponse(
    db: InventoryDatabase,
    id: number,
    user: AuthenticatedUserContext,
    lock = false,
  ) {
    const scope = await this.fmcs.resolve(user, db);
    const { asset, row } = await this.access(db, scope, id, user, lock);
    if (
      row.acceptedAt ||
      row.declinedAt
    ) {
      throw new ConflictException('This checkout acceptance is no longer pending');
    }
    const [assignee] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, row.assignedToId!), isNull(users.deletedAt)))
      .limit(1);
    if (!assignee) throw new ConflictException('The assignee is no longer available');
    return { asset, row, assignee };
  }

  private async signatureRequired(db: InventoryDatabase) {
    const [config] = await db
      .select({ signature: settings.requireAcceptSignature })
      .from(settings)
      .orderBy(settings.id)
      .limit(1);
    return config?.signature ?? false;
  }

  private async removeUnreferencedArtifacts(
    id: number,
    written: StoredArtifact[],
    finalizing: boolean,
  ) {
    let unreferenced = written;
    if (finalizing) {
      // Verify references before cleanup when the database may have committed the response.
      try {
        const [row] = await this.db
          .select({
            pdf: checkoutAcceptances.storedEulaFile,
            signature: checkoutAcceptances.signatureFilename,
          })
          .from(checkoutAcceptances)
          .where(eq(checkoutAcceptances.id, id))
          .limit(1);
        unreferenced = written.filter(({ key }) => key !== row?.pdf && key !== row?.signature);
      } catch {
        return;
      }
    }
    await Promise.allSettled(
      unreferenced.map(({ category, key }) => this.storage.deleteObject(category, key)),
    );
  }

  async download(id: number, kind: 'eula' | 'signature', user: AuthenticatedUserContext) {
    const { row } = await this.access(this.db, await this.fmcs.resolve(user), id, user);
    const key = kind === 'eula' ? row.storedEulaFile : row.signatureFilename;
    if (!row.acceptedAt || !key) throw new NotFoundException('Acceptance artifact not found');
    const object = await this.storage.getObjectStream(
      kind === 'eula' ? 'eulas' : 'signatures',
      key,
    );
    const extension = kind === 'eula' ? 'pdf' : 'png';
    return new StreamableFile(object.stream, {
      type: kind === 'eula' ? 'application/pdf' : 'image/png',
      length: object.size,
      disposition: `attachment; filename="acceptance-${id}.${extension}"`,
    });
  }

  private async access(
    db: InventoryDatabase,
    scope: FmcsScope,
    id: number,
    user: AuthenticatedUserContext,
    lock = false,
  ) {
    const query = db
      .select()
      .from(checkoutAcceptances)
      .where(
        and(
          eq(checkoutAcceptances.id, id),
          isNull(checkoutAcceptances.deletedAt),
        ),
      )
      .limit(1);
    const [row] = await (lock ? query.for('update') : query);
    const delegated =
      row?.checkoutableType === 'asset' && row.signInPlace && row.alertOnResponseId === user.id && permitsKey(user, 'assets.checkout');
    if (!row || (row.assignedToId !== user.id && !delegated))
      throw new NotFoundException('Checkout acceptance not found');
    const [item] = await db.execute<{
      inventory_id: number; name: string | null; tag: string | null; company_id: number | null;
      location_id: number | null; model_id: number | null; serial: string | null; item_type: PolymorphicItemType;
    }>(sql`select item.* from ${checkoutAcceptances} join lateral (
      ${this.subjects(scope, !row.acceptedAt && !row.declinedAt)}
    ) as item on true where ${checkoutAcceptances.id} = ${id}`);
    if (!item) {
      if (lock) throw new ConflictException('This checkout acceptance is no longer pending');
      throw new NotFoundException('Checkout acceptance not found');
    }
    return { row, asset: {
      id: item.inventory_id, name: item.name, assetTag: item.tag, itemType: item.item_type,
      companyId: item.company_id, locationId: item.location_id, modelId: item.model_id, serial: item.serial,
    } };

  }

  private present(row: Acceptance) {
    return {
      id: row.id,
      state: row.acceptedAt ? 'accepted' : row.declinedAt ? 'declined' : 'pending',
      accepted_at: row.acceptedAt?.toISOString() ?? null,
      declined_at: row.declinedAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
      has_eula: row.storedEulaFile !== null,
      has_signature: row.signatureFilename !== null,
    };
  }
}

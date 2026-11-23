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
} from '@kestrel-it/shared';
import { and, count, desc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { permitsKey } from '../../common/guards/permissions.guard.js';
import { STORAGE_PROVIDER, type StorageProvider } from '../../common/storage/storage.interface.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import {
  actionLogs,
  assets,
  checkoutAcceptances,
  models,
  settings,
  users,
} from '../../db/schema/index.js';
import { acceptancePdf, signaturePng } from './acceptance-artifacts.js';
import { fieldIssue } from './custom-fields-validation.service.js';
import { FmcsScopeService, type FmcsScope } from './fmcs-scope.service.js';
import { HardwareService } from './hardware.service.js';
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
    @Inject(HardwareService) private readonly hardware: HardwareService,
    @Inject(InventoryMailService) private readonly mail: InventoryMailService,
  ) {}

  async list(query: DatatableQuery, user: AuthenticatedUserContext, url: string, history = false) {
    const scope = await this.fmcs.resolve(user);
    const own = eq(checkoutAcceptances.assignedToId, user.id);
    const delegated = permitsKey(user, 'assets.checkout')
      ? and(
          eq(checkoutAcceptances.alertOnResponseId, user.id),
          eq(checkoutAcceptances.signInPlace, true),
        )
      : undefined;
    const filters = and(
      eq(checkoutAcceptances.checkoutableType, 'asset'),
      isNull(checkoutAcceptances.deletedAt),
      history ? own : or(own, delegated),
      history
        ? or(isNotNull(checkoutAcceptances.acceptedAt), isNotNull(checkoutAcceptances.declinedAt))
        : and(isNull(checkoutAcceptances.acceptedAt), isNull(checkoutAcceptances.declinedAt)),
      history ? undefined : eq(assets.assignedType, 'user'),
      history ? undefined : eq(assets.assignedTo, checkoutAcceptances.assignedToId),
      history
        ? this.fmcs.predicate(scope, 'hardware', assets.id, assets.companyId)
        : this.hardware.visible(scope),
    );
    const [[total], rows] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(checkoutAcceptances)
        .innerJoin(assets, eq(assets.id, checkoutAcceptances.checkoutableId))
        .where(filters),
      this.db
        .select({ acceptance: checkoutAcceptances, tag: assets.assetTag, name: assets.name })
        .from(checkoutAcceptances)
        .innerJoin(assets, eq(assets.id, checkoutAcceptances.checkoutableId))
        .where(filters)
        .orderBy(desc(checkoutAcceptances.id))
        .limit(query.limit)
        .offset(pageOffset(query)),
    ]);
    return datatable(
      total!.value,
      rows.map(({ acceptance, tag, name }) => ({
        ...this.present(acceptance),
        asset_tag: tag,
        asset_name: name,
      })),
      query,
      url,
    );
  }

  async get(id: number, user: AuthenticatedUserContext) {
    const scope = await this.fmcs.resolve(user);
    const { asset, row } = await this.access(this.db, scope, id, user);
    const [config] = await this.db
      .select({ signature: settings.requireAcceptSignature })
      .from(settings)
      .orderBy(settings.id)
      .limit(1);
    return {
      ...this.present(row),
      asset_tag: asset.assetTag,
      asset_name: asset.name,
      eula: row.storedEula,
      requires_signature: config?.signature ?? false,
    };
  }

  async respond(id: number, input: unknown, user: AuthenticatedUserContext) {
    const dto = parse(AcceptanceResponseSchema, input);
    const signature = dto.signature ? signaturePng(dto.signature) : null;
    const written: StoredArtifact[] = [];
    try {
      return await inventoryWrite(this.db, async (tx) => {
        const scope = await this.fmcs.resolve(user, tx);
        const { asset, row } = await this.access(tx, scope, id, user, true);
        if (
          row.acceptedAt ||
          row.declinedAt ||
          asset.assignedType !== 'user' ||
          asset.assignedTo !== row.assignedToId
        ) {
          throw new ConflictException('This checkout acceptance is no longer pending');
        }
        const [config] = await tx
          .select({ signature: settings.requireAcceptSignature })
          .from(settings)
          .orderBy(settings.id)
          .limit(1);
        const isAccepting = dto.decision === 'accept';
        if (isAccepting && config?.signature && !signature)
          fieldIssue('signature', 'A signature is required');
        const [assignee] = await tx
          .select()
          .from(users)
          .where(and(eq(users.id, row.assignedToId!), isNull(users.deletedAt)))
          .limit(1);
        if (!assignee) throw new ConflictException('The assignee is no longer available');
        const today = new Date();
        const label = asset.assetTag ?? `#${asset.id}`;
        const note = dto.note ?? null;
        let signatureFilename: string | null = null;
        let storedEulaFile: string | null = null;

        if (isAccepting) {
          const [model] =
            asset.modelId === null
              ? []
              : await tx
                  .select({ name: models.name })
                  .from(models)
                  .where(eq(models.id, asset.modelId))
                  .limit(1);
          const pdf = await acceptancePdf({
            tag: label,
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
        await tx
          .update(assets)
          .set({ accepted: isAccepting ? true : null, updatedAt: today })
          .where(eq(assets.id, asset.id));
        const action = isAccepting ? 'accepted' : 'declined';
        await tx.insert(actionLogs).values({
          actionType: action,
          itemType: 'asset',
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
          );
          if (isAccepting)
            await this.mail.enqueue(
              tx,
              assignee.email,
              `Asset acceptance confirmed: ${label}`,
              `Your acceptance for asset ${label} was recorded.`,
            );
        }
        return success({ id, state: action, has_eula: storedEulaFile !== null });
      });
    } catch (error) {
      if (written.length) {
        // A dropped database connection can leave the client unsure whether COMMIT succeeded.
        // Confirm references before deleting objects written by this attempt.
        const [row] = await this.db
          .select({
            pdf: checkoutAcceptances.storedEulaFile,
            signature: checkoutAcceptances.signatureFilename,
          })
          .from(checkoutAcceptances)
          .where(eq(checkoutAcceptances.id, id))
          .limit(1)
          .catch(() => [undefined]);
        if (row)
          await Promise.allSettled(
            written
              .filter(({ key }) => key !== row.pdf && key !== row.signature)
              .map(({ category, key }) => this.storage.deleteObject(category, key)),
          );
      }
      throw error;
    }
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
          eq(checkoutAcceptances.checkoutableType, 'asset'),
          isNull(checkoutAcceptances.deletedAt),
        ),
      )
      .limit(1);
    const [row] = await (lock ? query.for('update') : query);
    const delegated =
      row?.signInPlace && row.alertOnResponseId === user.id && permitsKey(user, 'assets.checkout');
    if (!row || (row.assignedToId !== user.id && !delegated))
      throw new NotFoundException('Checkout acceptance not found');
    if (!lock && (row.acceptedAt || row.declinedAt)) {
      const [archivable] = await db
        .select()
        .from(assets)
        .where(
          and(
            eq(assets.id, row.checkoutableId),
            this.fmcs.predicate(scope, 'hardware', assets.id, assets.companyId),
          ),
        )
        .limit(1);
      if (!archivable) throw new NotFoundException('Checkout acceptance not found');
      return { row, asset: archivable };
    }
    const asset = await this.hardware.find(db, scope, row.checkoutableId, { lock });
    return { row, asset };
  }

  private present(row: Acceptance) {
    return {
      id: row.id,
      asset_id: row.checkoutableId,
      state: row.acceptedAt ? 'accepted' : row.declinedAt ? 'declined' : 'pending',
      accepted_at: row.acceptedAt?.toISOString() ?? null,
      declined_at: row.declinedAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
      has_eula: row.storedEulaFile !== null,
      has_signature: row.signatureFilename !== null,
    };
  }
}

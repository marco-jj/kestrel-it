import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Patch,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import {
  DatatableQuerySchema,
  InventoryIdSchema,
  WEBHOOK_PROVIDERS,
  type AuthenticatedUserContext,
} from '@kestrel-it/shared';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import { permitsKey } from '../../common/guards/permissions.guard.js';
import type { EnvConfig } from '../../config/env.schema.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import {
  accessories,
  accessoriesCheckout,
  assets,
  authConsumedTokens,
  calendarEvents,
  checkoutAcceptances,
  consumables,
  consumablesUsers,
  inventoryMailOutbox,
  licenseSeats,
  licenses,
  scheduledJobRuns,
  settings,
  users,
} from '../../db/schema/index.js';
import { CheckoutAcceptancesService } from './checkout-acceptances.service.js';
import { FmcsScopeService, type FmcsScope } from './fmcs-scope.service.js';
import { InventoryMailService, notificationAddresses } from './inventory-mail.service.js';
import { inventoryWrite, parse, success, type InventoryTransaction } from './inventory-queries.js';
import { InventoryReadModelsService } from './inventory-read-models.service.js';
import { currentSettings, requireInventoryPermission } from './phase-three-queries.js';
import { webhookUrl } from './webhook-delivery.js';

const systemScope: FmcsScope = {
  enabled: false,
  floater: false,
  scopeLocations: false,
  companyIds: [],
};
const systemActor: AuthenticatedUserContext = {
  id: 0,
  username: 'scheduler',
  displayName: 'Scheduler',
  email: null,
  isSuperUser: true,
  isAdmin: false,
  userCompanyIds: [],
  groupIds: [],
  effectivePermissions: {} as AuthenticatedUserContext['effectivePermissions'],
  twoFactorEnrolled: false,
  twoFactorVerified: true,
  authMethod: 'jwt',
};
const dailyJobs = [
  'inventory-alerts',
  'expiring-alerts',
  'expected-checkin',
  'upcoming-audits',
] as const;
type DailyJob = (typeof dailyJobs)[number];
const dayMs = 86_400_000;
const weekPeriod = (date: string) => {
  const today = new Date(date);
  today.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
  return today.toISOString().slice(0, 10);
};

const settingsInput = z.object({
  alerts_enabled: z.boolean().optional(),
  alert_email: z.string().max(255).nullable().optional(),
  admin_cc_email: z.string().max(255).nullable().optional(),
  admin_cc_always: z.boolean().optional(),
  alert_interval: z.number().int().min(0).max(3650).nullable().optional(),
  alert_threshold: z.number().int().min(0).max(100_000).nullable().optional(),
  audit_warning_days: z.number().int().min(0).max(3650).nullable().optional(),
  due_checkin_days: z.number().int().min(0).max(3650).nullable().optional(),
  webhook_selected: z.enum(WEBHOOK_PROVIDERS).nullable().optional(),
  webhook_endpoint: z.string().max(500).nullable().optional(),
  webhook_channel: z.string().max(255).nullable().optional(),
  webhook_botname: z.string().max(255).nullable().optional(),
});

@Controller()
export class NotificationsController {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(ConfigService) private readonly env: ConfigService<EnvConfig, true>,
    @Inject(FmcsScopeService) private readonly fmcs: FmcsScopeService,
    @Inject(InventoryMailService) private readonly mail: InventoryMailService,
    @Inject(InventoryReadModelsService) private readonly readModels: InventoryReadModelsService,
    @Inject(CheckoutAcceptancesService) private readonly acceptances: CheckoutAcceptancesService,
  ) {}

  private admin(user: AuthenticatedUserContext) {
    if (!user.isSuperUser)
      throw new ForbiddenException('Only superusers can configure notifications');
  }

  @Get('settings/notifications')
  async settings(@CurrentUser() user: AuthenticatedUserContext) {
    this.admin(user);
    const row = await currentSettings(this.db);
    if (!row) throw new NotFoundException('Settings not found');
    return success({
      alerts_enabled: row.alertsEnabled,
      alert_email: row.alertEmail,
      admin_cc_email: row.adminCcEmail,
      admin_cc_always: row.adminCcAlways,
      alert_interval: row.alertInterval,
      alert_threshold: row.alertThreshold,
      audit_warning_days: row.auditWarningDays,
      due_checkin_days: row.dueCheckinDays,
      webhook_selected: row.webhookSelected,
      webhook_configured: Boolean(row.webhookEndpoint),
      webhook_channel: row.webhookChannel,
      webhook_botname: row.webhookBotname,
      timezone: this.env.get('SCHEDULER_TIMEZONE', { infer: true }),
    });
  }

  @Patch('settings/notifications')
  async update(@Body() raw: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    this.admin(user);
    const input = parse(settingsInput, raw);
    if (input.webhook_endpoint) {
      try {
        webhookUrl(input.webhook_endpoint);
      } catch {
        throw new UnprocessableEntityException('Enter a public HTTPS webhook URL');
      }
    }
    for (const value of [input.alert_email, input.admin_cc_email]) {
      if (
        value &&
        notificationAddresses(value).length !==
          new Set(value.split(',').map((email) => email.trim())).size
      )
        throw new UnprocessableEntityException('Enter valid email addresses separated by commas');
    }
    await inventoryWrite(this.db, async (tx) => {
      const config = await currentSettings(tx);
      if (!config) throw new NotFoundException('Settings not found');
      const endpoint =
        input.webhook_endpoint === undefined ? config.webhookEndpoint : input.webhook_endpoint;
      const provider =
        input.webhook_selected === undefined ? config.webhookSelected : input.webhook_selected;
      if (endpoint && !provider)
        throw new UnprocessableEntityException('Select a webhook provider');
      await tx
        .update(settings)
        .set({
          alertsEnabled: input.alerts_enabled,
          alertEmail: input.alert_email,
          adminCcEmail: input.admin_cc_email,
          adminCcAlways: input.admin_cc_always,
          alertInterval: input.alert_interval,
          alertThreshold: input.alert_threshold,
          auditWarningDays: input.audit_warning_days,
          dueCheckinDays: input.due_checkin_days,
          webhookSelected: input.webhook_selected,
          webhookEndpoint: input.webhook_endpoint,
          webhookChannel: input.webhook_channel,
          webhookBotname: input.webhook_botname,
        })
        .where(eq(settings.id, config.id));
    });
    return this.settings(user);
  }

  @Post('settings/notifications/test')
  async testMail(@Body() raw: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    this.admin(user);
    const { email } = parse(z.object({ email: z.string().email().optional() }), raw ?? {});
    const recipient = email ?? user.email;
    if (!recipient) throw new UnprocessableEntityException('Enter a test recipient');
    await inventoryWrite(this.db, (tx) =>
      this.mail.enqueue(
        tx,
        recipient,
        'Kestrel-IT test email',
        'This message verifies outbound email delivery.',
        'mail-test',
      ),
    );
    return success(null, 'Test email queued');
  }

  @Post('users/:id/email')
  async currentInventory(
    @Param('id') value: string,
    @CurrentUser() actor: AuthenticatedUserContext,
  ) {
    const id = parse(InventoryIdSchema, value);
    if (id !== actor.id) requireInventoryPermission(actor, 'users.edit');
    const scope = await this.fmcs.resolve(actor);
    return inventoryWrite(this.db, async (tx) => {
      const [target] = await tx
        .select()
        .from(users)
        .where(
          and(
            eq(users.id, id),
            isNull(users.deletedAt),
            this.fmcs.predicate(scope, 'users', users.id),
          ),
        );
      if (!target) throw new NotFoundException('User not found');
      if (!target.email) throw new UnprocessableEntityException('User has no email address');
      const assetScope =
        this.fmcs.predicate(scope, 'assets', assets.id, assets.companyId) ?? sql`true`;
      const accessoryScope =
        this.fmcs.predicate(scope, 'accessories', accessories.id, accessories.companyId) ??
        sql`true`;
      const consumableScope =
        this.fmcs.predicate(scope, 'consumables', consumables.id, consumables.companyId) ??
        sql`true`;
      const licenseScope =
        this.fmcs.predicate(scope, 'licenses', licenses.id, licenses.companyId) ?? sql`true`;
      const inventory = await tx.execute<{ label: string }>(sql`
        select concat('Asset: ',coalesce(${assets.assetTag},${assets.name})) as label from ${assets}
          where ${assets.assignedType} = 'user' and ${assets.assignedTo} = ${id} and ${assets.deletedAt} is null
          and (${assetScope})
        union all select concat('Accessory: ',${accessories.name}) from ${accessories} join ${accessoriesCheckout}
          on ${accessoriesCheckout.accessoryId} = ${accessories.id}
          where ${accessoriesCheckout.assignedType}='user' and ${accessoriesCheckout.assignedTo}=${id}
          and ${accessories.deletedAt} is null and (${accessoryScope})
        union all select concat('Consumable: ',${consumables.name}) from ${consumables} join ${consumablesUsers}
          on ${consumablesUsers.consumableId} = ${consumables.id}
          where ${consumablesUsers.assignedTo}=${id} and ${consumables.deletedAt} is null and (${consumableScope})
        union all select concat('License: ',${licenses.name}) from ${licenses} join ${licenseSeats}
          on ${licenseSeats.licenseId}=${licenses.id} where ${licenseSeats.assignedTo}=${id}
          and ${licenses.deletedAt} is null and ${licenseSeats.deletedAt} is null and (${licenseScope}) order by label
      `);
      await this.mail.enqueue(
        tx,
        target.email,
        'Your assigned inventory',
        inventory.map((row) => row.label).join('\n') ||
          'There are no inventory items assigned to you.',
        'current-inventory',
      );
      return success(null, 'Inventory email queued');
    });
  }

  @Post('unaccepted-acceptances/send-reminders')
  async remind(@Body() raw: unknown, @CurrentUser() actor: AuthenticatedUserContext) {
    const { ids } = parse(z.object({ ids: z.array(InventoryIdSchema).min(1).max(500) }), raw);
    const keys = {
      asset: 'assets.checkout',
      accessory: 'accessories.checkout',
      license: 'licenses.checkout',
      consumable: 'consumables.checkout',
    } as const;
    const allowed = Object.entries(keys)
      .filter(([, key]) => permitsKey(actor, key))
      .map(([type]) => type);
    if (!allowed.length) throw new ForbiddenException('Checkout permission required');
    const scope = await this.fmcs.resolve(actor);
    return inventoryWrite(this.db, async (tx) =>
      success(await this.queueReminders(tx, scope, allowed, ids)),
    );
  }

  private async queueReminders(
    tx: InventoryTransaction,
    scope: FmcsScope,
    types: string[],
    ids?: number[],
  ) {
    const pending = checkoutAcceptances;
    const rows = await tx.execute<{ id: number; user_id: number; email: string | null }>(sql`
      select ${pending.id}, ${users.id} as user_id, ${users.email} from ${pending}
      join lateral (${this.acceptances.subjects(scope, true)}) item on true
      join ${users} on ${users.id} = ${pending.assignedToId} and ${users.deletedAt} is null
      where ${pending.deletedAt} is null and ${pending.acceptedAt} is null and ${pending.declinedAt} is null
      and item.item_type in (${sql.join(
        types.map((type) => sql`${type}`),
        sql`, `,
      )})
      ${ids ? sql`and ${inArray(pending.id, ids)}` : sql.empty()}
      and ${this.fmcs.predicate(scope, 'users', users.id) ?? sql`true`}
      order by ${pending.id}`);
    const groups = new Map<number, Array<(typeof rows)[number]>>();
    for (const row of rows) {
      const group = groups.get(row.user_id) ?? [];
      group.push(row);
      groups.set(row.user_id, group);
    }
    let queued = 0;
    let no_email = 0;
    const url = new URL('/account/accept', this.env.get('APP_URL', { infer: true })).href;
    for (const group of groups.values()) {
      const email = group[0]?.email;
      if (!notificationAddresses(email).length) {
        no_email += 1;
        continue;
      }
      await this.mail.enqueue(
        tx,
        email,
        'Inventory acceptance reminder',
        `You have ${group.length} pending inventory acceptance(s).\n${url}`,
        'acceptance.reminder',
      );
      queued += 1;
    }
    return { queued, no_email };
  }

  @Interval(60_000)
  async tick() {
    try {
      await this.runDue(new Date());
    } catch {
      /* Another interval can retry an unavailable database. */
    }
  }

  private async once(
    job: string,
    period: string,
    now: Date,
    work: (tx: InventoryTransaction) => Promise<void>,
  ) {
    await this.db.transaction(async (tx) => {
      const [lock] = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(64103,hashtext(${job})) as locked`,
      );
      if (!lock?.locked) return;
      const [run] = await tx
        .insert(scheduledJobRuns)
        .values({ job, period, createdAt: now })
        .onConflictDoNothing()
        .returning();
      if (run) await work(tx);
    });
  }

  async runDue(now: Date) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.env.get('SCHEDULER_TIMEZONE', { infer: true }),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(now).map((part) => [part.type, part.value]),
    );
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const config = await currentSettings(this.db);
    if (!config) return;
    if (config.alertsEnabled) {
      for (const job of dailyJobs)
        await this.once(job, date, now, (tx) => this.daily(tx, job, date, config));
      await this.once('acceptance-reminders', weekPeriod(date), now, async (tx) => {
        await this.queueReminders(tx, systemScope, ['asset', 'accessory', 'license', 'consumable']);
      });
    }
    const period = new Date(Math.floor(now.valueOf() / 900_000) * 900_000).toISOString();
    await this.once('auth-token-cleanup', period, now, async (tx) => {
      await tx.delete(authConsumedTokens).where(lt(authConsumedTokens.expiresAt, now));
    });
    await this.once('operational-cleanup', date, now, async (tx) => {
      const cutoff = new Date(now.valueOf() - 90 * dayMs);
      await tx
        .delete(inventoryMailOutbox)
        .where(
          sql`coalesce(${inventoryMailOutbox.sentAt},${inventoryMailOutbox.failedAt}) < ${cutoff.toISOString()}::timestamptz`,
        );
      await tx.delete(scheduledJobRuns).where(lt(scheduledJobRuns.createdAt, cutoff));
    });
  }

  private async daily(
    tx: InventoryTransaction,
    job: DailyJob,
    date: string,
    config: typeof settings.$inferSelect,
  ) {
    const alertEmails = [config.alertEmail, config.adminCcEmail].filter(Boolean).join(',');
    if (job === 'inventory-alerts') {
      if (!alertEmails) return;
      const stock = await this.readModels.lowStock(
        parse(DatatableQuerySchema, { limit: 100 }),
        systemActor,
        '/low-stock',
        tx,
      );
      if (stock.total)
        await this.mail.enqueue(
          tx,
          alertEmails,
          'Low inventory stock',
          `${stock.total} item(s) are below the alert threshold.\n${stock.rows
            .map((item) => {
              const row = item as typeof item & { name: string; remaining: number };
              return `${row.name}: ${row.remaining} remaining`;
            })
            .join('\n')}`,
          'stock.low',
        );
      return;
    }
    if (job === 'expiring-alerts') {
      const days = config.alertInterval ?? 0;
      if (!days || !alertEmails) return;
      const expires = await tx.execute<{
        asset_tag: string;
        event_type: string;
        event_date: string;
      }>(sql`
        select distinct ${assets.assetTag},${calendarEvents.eventType}, ${calendarEvents.start}::date as event_date
        from ${calendarEvents} join ${assets} on ${assets.id}=${calendarEvents.sourceId}
        where ${calendarEvents.sourceType}='asset' and ${calendarEvents.eventType} in ('asset.warranty_expiration','asset.eol')
          and ${assets.deletedAt} is null and ${calendarEvents.deletedAt} is null
          and ${calendarEvents.start}::date between ${date}::date and ${date}::date + ${days}::int order by event_date`);
      const expiringLicenses = await tx
        .select({ name: licenses.name, date: licenses.expirationDate })
        .from(licenses)
        .where(
          and(
            isNull(licenses.deletedAt),
            sql`${licenses.expirationDate} between ${date}::date and ${date}::date + ${days}::int`,
          ),
        );
      if (expires.length)
        await this.mail.enqueue(
          tx,
          alertEmails,
          'Asset warranty or EOL alerts',
          expires.map((row) => `${row.asset_tag} — ${row.event_type} ${row.event_date}`).join('\n'),
          'expiry.asset',
        );
      if (expiringLicenses.length)
        await this.mail.enqueue(
          tx,
          alertEmails,
          'Expiring licenses',
          expiringLicenses.map((row) => `${row.name} — ${row.date}`).join('\n'),
          'expiry.license',
        );
      return;
    }
    if (job === 'upcoming-audits') {
      if (!alertEmails) return;
      const audited = await tx
        .select({ tag: assets.assetTag, date: assets.nextAuditDate })
        .from(assets)
        .where(
          and(
            isNull(assets.deletedAt),
            sql`${assets.nextAuditDate} <= ${date}::date + ${config.auditWarningDays ?? 0}::int`,
          ),
        )
        .orderBy(assets.nextAuditDate)
        .limit(30);
      if (audited.length)
        await this.mail.enqueue(
          tx,
          alertEmails,
          'Upcoming and overdue audits',
          audited.map((row) => `${row.tag} — ${row.date}`).join('\n'),
          'audit.upcoming',
        );
      return;
    }
    const due = await tx
      .select({ tag: assets.assetTag, date: assets.expectedCheckin, email: users.email })
      .from(assets)
      .leftJoin(
        users,
        and(
          eq(assets.assignedType, 'user'),
          eq(assets.assignedTo, users.id),
          isNull(users.deletedAt),
        ),
      )
      .where(
        and(
          isNull(assets.deletedAt),
          sql`${assets.assignedTo} is not null and
        ${assets.expectedCheckin} <= ${date}::date + ${config.dueCheckinDays ?? 0}::int`,
        ),
      );
    for (const row of due)
      await this.mail.enqueue(
        tx,
        row.email,
        `Asset return due: ${row.tag}`,
        `Please return asset ${row.tag}. Expected return: ${row.date}.`,
        'expected.user',
      );
    if (due.length)
      await this.mail.enqueue(
        tx,
        alertEmails,
        'Expected asset returns',
        due.map((row) => `${row.tag} — ${row.date}`).join('\n'),
        'expected.admin',
      );
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { STORAGE_PROVIDER, type StorageProvider } from '../../common/storage/storage.interface.js';
import { Interval } from '@nestjs/schedule';
import { and, isNull, lte } from 'drizzle-orm';
import { createTransport } from 'nodemailer';
import type { EnvConfig } from '../../config/env.schema.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import { assets, companies, inventoryMailOutbox, users } from '../../db/schema/index.js';
import type { InventoryTransaction } from './inventory-queries.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { currentSettings } from './phase-three-queries.js';
import { postWebhook, webhookPayload } from './webhook-delivery.js';

export const notificationEvents = [
  'checkout.asset',
  'checkout.accessory',
  'checkout.consumable',
  'checkout.component',
  'checkout.license',
  'checkin.asset',
  'checkin.accessory',
  'checkin.component',
  'checkin.license',
  'acceptance.accepted',
  'acceptance.receipt',
  'acceptance.declined',
  'acceptance.reminder',
  'request.created',
  'request.canceled',
  'audit.recorded',
  'audit.upcoming',
  'expected.user',
  'expected.admin',
  'expiry.asset',
  'expiry.license',
  'stock.low',
  'welcome',
  'first-admin',
  'current-inventory',
  'mail-test',
] as const;
export type NotificationEvent = (typeof notificationEvents)[number];

export const notificationAddresses = (value: string | null | undefined) => [
  ...new Set(
    (value ?? '')
      .split(',')
      .map((email) => email.trim())
      .filter((email) => z.string().email().safeParse(email).success),
  ),
];
const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

@Injectable()
export class InventoryMailService {
  private readonly logger = new Logger(InventoryMailService.name);
  private readonly transport;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(ConfigService) private readonly env: ConfigService<EnvConfig, true>,
  ) {
    const user = env.get('SMTP_USER', { infer: true });
    this.transport = createTransport({
      host: env.get('SMTP_HOST', { infer: true }),
      port: env.get('SMTP_PORT', { infer: true }),
      secure: env.get('SMTP_SECURE', { infer: true }),
      auth: user ? { user, pass: env.get('SMTP_PASSWORD', { infer: true }) } : undefined,
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      socketTimeout: 10_000,
    });
  }

  async enqueue(
    tx: InventoryTransaction,
    recipient: string | null | undefined,
    subject: string,
    message: string,
    event?: NotificationEvent,
  ) {
    const recipients = notificationAddresses(recipient);
    if (!recipients.length) return;
    await tx
      .insert(inventoryMailOutbox)
      .values(
        recipients.map((address) => ({
          recipient: address,
          subject: subject.slice(0, 255),
          message,
          event,
          availableAt: new Date(),
        })),
      );
  }

  async lifecycle(
    tx: InventoryTransaction,
    input: {
      event: NotificationEvent;
      recipient?: string | null;
      subject: string;
      message: string;
      companyId: number | null;
      alertOnResponse?: boolean;
      suppressEmail?: boolean;
      webhookMessage?: string;
    },
  ) {
    const config = await currentSettings(tx);
    if (!input.suppressEmail) {
      const recipients = notificationAddresses(input.recipient);
      if (config?.adminCcAlways || input.alertOnResponse)
        recipients.push(...notificationAddresses(config?.adminCcEmail));
      await this.enqueue(
        tx,
        [...new Set(recipients.map((email) => email.toLowerCase()))].join(','),
        input.subject,
        input.message,
        input.event,
      );
    }
    const [company] =
      input.companyId === null
        ? []
        : await tx
            .select()
            .from(companies)
            .where(and(eq(companies.id, input.companyId), isNull(companies.deletedAt)));
    if (company?.webhookEndpoint || config?.webhookEndpoint) {
      await tx
        .insert(inventoryMailOutbox)
        .values({
          recipient: '',
          channel: 'webhook',
          companyId: input.companyId,
          event: input.event,
          subject: input.subject.slice(0, 255),
          message: input.webhookMessage ?? input.subject,
          availableAt: new Date(),
        });
    }
  }

  async emailRecipient(tx: InventoryTransaction, type: string | null, id: number | null) {
    if (!id) return null;
    let userId = type === 'user' ? id : null;
    if (type === 'asset') {
      const [asset] = await tx
        .select({ id: assets.assignedTo })
        .from(assets)
        .where(and(eq(assets.id, id), eq(assets.assignedType, 'user'), isNull(assets.deletedAt)));
      userId = asset?.id ?? null;
    }
    if (!userId) return null;
    const [user] = await tx
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));
    return user?.email ?? null;
  }

  private async emailLogo(key: string | null | undefined) {
    if (!key || !/\.(png|jpe?g|gif)$/i.test(key)) return undefined;
    try {
      const object = await this.storage.getObjectStream('branding', key);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of object.stream) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          object.stream.destroy();
          return undefined;
        }
        chunks.push(Buffer.from(chunk));
      }
      const content = Buffer.concat(chunks);
      const magic = content.subarray(0, 8);
      const contentType =
        magic.toString('hex') === '89504e470d0a1a0a'
          ? 'image/png'
          : magic.subarray(0, 3).toString('hex') === 'ffd8ff'
            ? 'image/jpeg'
            : magic.toString('ascii').startsWith('GIF8')
              ? 'image/gif'
              : undefined;
      return contentType
        ? { filename: 'branding-logo', cid: 'kestrel-branding', contentType, content }
        : undefined;
    } catch {
      return undefined;
    }
  }

  @Interval(15_000)
  async dispatch(): Promise<void> {
    try {
      for (let index = 0; index < 5; index += 1) {
        const next = await this.deliverOne();
        if (!next) return;
      }
    } catch {
      this.logger.warn('Could not read the inventory notification queue');
    }
  }

  async deliverOne(): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(inventoryMailOutbox)
        .where(
          and(
            isNull(inventoryMailOutbox.sentAt),
            isNull(inventoryMailOutbox.failedAt),
            lte(inventoryMailOutbox.availableAt, new Date()),
          ),
        )
        .orderBy(inventoryMailOutbox.availableAt, inventoryMailOutbox.id)
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return false;
      const selector = eq(inventoryMailOutbox.id, row.id);
      const from = this.env.get('SMTP_FROM_ADDRESS', { infer: true });
      try {
        const config = await currentSettings(tx);
        if (row.channel === 'webhook') {
          const [company] =
            row.companyId === null
              ? []
              : await tx
                  .select()
                  .from(companies)
                  .where(and(eq(companies.id, row.companyId), isNull(companies.deletedAt)));
          const target = company?.webhookEndpoint && company.webhookSelected ? company : config;
          if (!target?.webhookEndpoint || !target.webhookSelected)
            throw new Error('No webhook destination is configured for this delivery');
          await postWebhook(
            target.webhookEndpoint,
            webhookPayload(
              target.webhookSelected,
              row.event ?? 'inventory',
              row.subject,
              row.message,
              target.webhookChannel,
              target.webhookBotname,
            ),
            `inventory-${row.id}`,
          );
        } else {
          const logo = config?.showImagesInEmail
            ? await this.emailLogo(config.emailLogo)
            : undefined;
          const title = escapeHtml(config?.siteName ?? 'Kestrel-IT');
          const html = `${logo ? '<img src="cid:kestrel-branding" width="160" alt="" />' : ''}<h1 style="font-size:20px">${title}</h1><div style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(row.message)}</div>`;
          await this.transport.sendMail({
            from: { name: this.env.get('SMTP_FROM_NAME', { infer: true }), address: from },
            to: row.recipient,
            subject: row.subject,
            text: row.message,
            html,
            ...(logo ? { attachments: [logo] } : {}),
            messageId: `<inventory-${row.id}@${from.split('@').at(-1)}>`,
          });
        }
      } catch {
        const attempts = row.attempts + 1;
        await tx
          .update(inventoryMailOutbox)
          .set({
            attempts,
            failedAt: attempts >= 8 ? new Date() : null,
            availableAt: new Date(Date.now() + 30_000 * 2 ** Math.min(attempts, 8)),
          })
          .where(selector);
        this.logger.warn(`Inventory notification ${row.id} delivery failed on attempt ${attempts}`);
        return true;
      }
      await tx.update(inventoryMailOutbox).set({ sentAt: new Date() }).where(selector);
      return true;
    });
  }
}

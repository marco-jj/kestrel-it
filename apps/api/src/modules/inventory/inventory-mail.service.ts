import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { and, isNull, lte } from 'drizzle-orm';
import { createTransport } from 'nodemailer';
import type { EnvConfig } from '../../config/env.schema.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import { inventoryMailOutbox } from '../../db/schema/index.js';
import type { InventoryTransaction } from './inventory-queries.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

@Injectable()
export class InventoryMailService {
  private readonly logger = new Logger(InventoryMailService.name);
  private readonly transport;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
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
  ) {
    if (!recipient || !z.string().email().safeParse(recipient).success) return;
    await tx
      .insert(inventoryMailOutbox)
      .values({ recipient, subject: subject.slice(0, 255), message });
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
        await this.transport.sendMail({
          from: { name: this.env.get('SMTP_FROM_NAME', { infer: true }), address: from },
          to: row.recipient,
          subject: row.subject,
          text: row.message,
          messageId: `<inventory-${row.id}@${from.split('@').at(-1)}>`,
        });
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

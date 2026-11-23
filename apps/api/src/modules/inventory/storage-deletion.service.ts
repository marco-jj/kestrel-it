import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, eq, lte } from 'drizzle-orm';
import { STORAGE_PROVIDER, type StorageProvider } from '../../common/storage/storage.interface.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import { storageDeletionQueue } from '../../db/schema/index.js';

@Injectable()
export class StorageDeletionService {
  private readonly logger = new Logger(StorageDeletionService.name);
  private busy = false;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  @Interval(15_000)
  async dispatch() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let index = 0; index < 10; index++) {
        if (!(await this.deleteOne())) break;
      }
    } catch {
      this.logger.warn('Could not process the storage deletion queue');
    } finally {
      this.busy = false;
    }
  }

  async deleteOne(now = new Date()) {
    // Only the queue row is locked while the storage provider is called.
    return this.db.transaction(async (tx) => {
      const [entry] = await tx
        .select()
        .from(storageDeletionQueue)
        .where(lte(storageDeletionQueue.availableAt, now))
        .orderBy(
          storageDeletionQueue.availableAt,
          storageDeletionQueue.category,
          storageDeletionQueue.objectKey,
        )
        .limit(1)
        .for('update', { skipLocked: true });
      if (!entry) return false;
      const selector = and(
        eq(storageDeletionQueue.category, entry.category),
        eq(storageDeletionQueue.objectKey, entry.objectKey),
      );
      try {
        await this.storage.deleteObject(entry.category, entry.objectKey);
      } catch {
        const attempts = entry.attempts + 1;
        await tx
          .update(storageDeletionQueue)
          .set({
            attempts,
            availableAt: new Date(now.valueOf() + 30_000 * 2 ** Math.min(attempts, 8)),
          })
          .where(selector);
        this.logger.warn(`Storage cleanup in ${entry.category} failed on attempt ${attempts}`);
        return true;
      }
      await tx.delete(storageDeletionQueue).where(selector);
      return true;
    });
  }
}

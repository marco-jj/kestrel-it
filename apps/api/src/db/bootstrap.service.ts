import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { count, sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { randomBytes, scryptSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import type { EnvConfig } from '../config/env.schema.js';
import { DRIZZLE_DB, type DrizzleDb } from './database.tokens.js';
import { authConsumedTokens, inventoryMailOutbox, settings, statusLabels, users } from './schema/index.js';

type DbOrTx = Pick<DrizzleDb, 'select' | 'insert'>;
const STARTUP_LOCK = 1_804_723_651;
const packagedMigrations = new URL('../drizzle/', import.meta.url);
const migrationConfig = {
  migrationsFolder: fileURLToPath(
    existsSync(new URL('meta/_journal.json', packagedMigrations))
      ? packagedMigrations
      : new URL('../../drizzle/', import.meta.url),
  ),
};

function hashPasswordScrypt(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derivedKey}`;
}

@Injectable()
export class DatabaseBootstrapService {
  private readonly logger = new Logger(DatabaseBootstrapService.name);
  private readonly requiredMigrations = readMigrationFiles(migrationConfig);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(ConfigService) private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  async initialize(client: Sql): Promise<void> {
    const connection = await client.reserve();
    try {
      await connection`SELECT pg_advisory_lock(${STARTUP_LOCK})`;
      if (this.config.get('DB_AUTO_MIGRATE', { infer: true })) {
        await migrate(this.db, migrationConfig);
      }
      await this.checkSchema();
      await this.runHeadlessBootstrapIfConfigured();
    } finally {
      try {
        await connection`SELECT pg_advisory_unlock(${STARTUP_LOCK})`;
      } finally {
        connection.release();
      }
    }
  }

  async checkSchema(): Promise<void> {
    const applied = await this.db
      .execute<{ hash: string; created_at: string }>(
        sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations`,
      )
      .catch((cause: unknown) => {
        throw new Error('Cannot read the Drizzle migration journal. Apply pending migrations.', {
          cause,
        });
      });
    const recorded = new Set(applied.map(({ created_at, hash }) => `${created_at}:${hash}`));
    if (
      this.requiredMigrations.some(({ folderMillis, hash }) => !recorded.has(`${folderMillis}:${hash}`))
    ) {
      throw new Error('The Drizzle migration journal is missing migrations required by this release');
    }
    await this.db.execute(sql`
      SELECT 1
      FROM ${settings}, ${users}, ${statusLabels}, ${authConsumedTokens}
      LIMIT 0
    `);
  }

  /**
   * Mirrors Snipe-IT Setting::setupCompleted(): true only when at least one user and one settings row exist.
   */
  async isSetupCompleted(): Promise<boolean> {
    try {
      const [userRow] = await this.db.select({ total: count() }).from(users);
      const [settingsRow] = await this.db.select({ total: count() }).from(settings);
      return Number(userRow?.total ?? 0) > 0 && Number(settingsRow?.total ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Seeds default Asset status labels if the table is empty.
   */
  async seedDefaultStatusLabels(executor: DbOrTx = this.db): Promise<void> {
    const [existing] = await executor.select({ total: count() }).from(statusLabels);
    if (Number(existing?.total ?? 0) > 0) {
      return;
    }

    await executor.insert(statusLabels).values([
      {
        name: 'Ready to Deploy',
        deployable: true,
        pending: false,
        archived: false,
        color: '#10b981',
        showInNav: true,
        defaultLabel: true,
      },
      {
        name: 'Pending',
        deployable: false,
        pending: true,
        archived: false,
        color: '#f59e0b',
        showInNav: true,
        defaultLabel: false,
      },
      {
        name: 'Archived',
        deployable: false,
        pending: false,
        archived: true,
        color: '#6b7280',
        showInNav: true,
        defaultLabel: false,
      },
      {
        name: 'Out for Repair',
        deployable: false,
        pending: false,
        archived: false,
        color: '#ef4444',
        showInNav: false,
        defaultLabel: false,
      },
    ]);
  }

  /**
   * Runs zero-touch bootstrap if BOOTSTRAP_ADMIN_* environment variables are configured and setup is incomplete.
   */
  async runHeadlessBootstrapIfConfigured(): Promise<boolean> {
    const username = this.config.get('BOOTSTRAP_ADMIN_USERNAME', { infer: true })?.trim();
    const email = this.config.get('BOOTSTRAP_ADMIN_EMAIL', { infer: true })?.trim();
    const password = this.config.get('BOOTSTRAP_ADMIN_PASSWORD', { infer: true });

    if (await this.isSetupCompleted()) {
      return false;
    }

    if (!username || !email || !password) {
      await this.seedDefaultStatusLabels();
      return false;
    }

    const firstName = this.config.get('BOOTSTRAP_ADMIN_FIRST_NAME', { infer: true }) || 'Admin';
    const lastName = this.config.get('BOOTSTRAP_ADMIN_LAST_NAME', { infer: true }) || 'User';
    const siteName =
      this.config.get('BOOTSTRAP_SITE_NAME', { infer: true })?.trim() ||
      this.config.get('APP_NAME', { infer: true });

    await this.db.transaction(async (tx) => {
      await this.seedDefaultStatusLabels(tx);

      const [adminUser] = await tx
        .insert(users)
        .values({
          username,
          email,
          firstName,
          lastName,
          displayName: `${firstName} ${lastName}`.trim(),
          password: hashPasswordScrypt(password),
          activated: true,
          activatedAt: new Date(),
          permissions: { superuser: 1 },
        })
        .returning({ id: users.id });

      await tx.insert(settings).values({
        id: 1,
        siteName,
        alertEmail: email,
        createdBy: adminUser?.id ?? 1,
      });
      await tx.insert(inventoryMailOutbox).values({
        recipient: email, subject: 'Kestrel-IT is ready',
        message: `Your administrator account for ${siteName} has been created.`, event: 'first-admin',
        availableAt: new Date(),
      });
    });

    this.logger.log(`Headless bootstrap completed for admin user "${username}".`);
    return true;
  }
}

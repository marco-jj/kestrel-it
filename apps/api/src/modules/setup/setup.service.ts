import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  CompleteSetupRequest,
  LoginResponse,
  PreflightStatusResponse,
} from '@kestrel-it/shared';
import { sql } from 'drizzle-orm';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EnvConfig } from '../../config/env.schema.js';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import { DatabaseBootstrapService } from '../../db/bootstrap.service.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import { actionLogs, settings, users } from '../../db/schema/index.js';
import { AuthService } from '../auth/auth.service.js';

@Injectable()
export class SetupService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(ConfigService) private readonly config: ConfigService<EnvConfig, true>,
    @Inject(DatabaseBootstrapService)
    private readonly bootstrapService: DatabaseBootstrapService,
    @Inject(CryptoService) private readonly cryptoService: CryptoService,
    @Inject(AuthService) private readonly authService: AuthService,
  ) {}

  async getPreflightStatus(): Promise<PreflightStatusResponse> {
    const setupCompleted = await this.bootstrapService.isSetupCompleted();

    let database = false;
    try {
      await this.db.execute(sql`SELECT 1`);
      database = true;
    } catch {
      database = false;
    }

    const storageWritable = this.checkStorageConfiguredAndWritable();
    const oidcConfigured = Boolean(
      this.config.get('OIDC_ENABLED', { infer: true }) &&
        this.config.get('OIDC_ISSUER_URL', { infer: true }) &&
        this.config.get('OIDC_CLIENT_ID', { infer: true }),
    );
    const smtpConfigured = Boolean(
      this.config.get('SMTP_HOST', { infer: true }) &&
        this.config.get('SMTP_FROM_ADDRESS', { infer: true }),
    );

    return {
      setupCompleted,
      checks: {
        database,
        storageWritable,
        oidcConfigured,
        smtpConfigured,
      },
    };
  }

  async completeSetup(dto: CompleteSetupRequest): Promise<LoginResponse> {
    if (await this.bootstrapService.isSetupCompleted()) {
      throw new ForbiddenException('Application setup has already been completed.');
    }

    const createdUserId = await this.db.transaction(async (tx) => {
      await this.bootstrapService.seedDefaultStatusLabels(tx);

      const passwordHash = this.cryptoService.hashPassword(dto.password);
      const displayName = `${dto.firstName} ${dto.lastName}`.trim() || dto.username;

      const [adminUser] = await tx
        .insert(users)
        .values({
          username: dto.username,
          email: dto.email,
          firstName: dto.firstName,
          lastName: dto.lastName,
          displayName,
          password: passwordHash,
          activated: true,
          activatedAt: new Date(),
          locale: dto.locale,
          permissions: { superuser: 1 },
        })
        .returning({ id: users.id });

      if (!adminUser) {
        throw new Error('Failed to insert initial superuser');
      }

      await tx.insert(settings).values({
        id: 1,
        siteName: dto.siteName,
        locale: dto.locale,
        defaultCurrency: dto.defaultCurrency,
        fullMultipleCompaniesSupport: dto.fullMultipleCompaniesSupport,
        autoIncrementAssets: dto.autoIncrementAssets,
        autoIncrementPrefix: dto.autoIncrementPrefix ?? null,
        zerofillCount: dto.zerofillCount,
        nextAutoTagBase: 1,
        emailDomain: dto.emailDomain ?? null,
        emailFormat: dto.emailFormat ?? null,
        alertEmail: dto.email,
        createdBy: adminUser.id,
      });

      await tx.insert(actionLogs).values({
        createdBy: adminUser.id,
        actionType: 'create',
        itemType: 'user',
        itemId: adminUser.id,
        actionDate: new Date(),
        actionSource: 'gui',
        note: 'Initial superuser created via first-run setup wizard',
      });

      return adminUser.id;
    });

    return this.authService.issueSessionForUser(createdUserId, true);
  }

  private checkStorageConfiguredAndWritable(): boolean {
    const driver = this.config.get('STORAGE_DRIVER', { infer: true });
    if (driver === 'local') {
      try {
        const localRoot = resolve(this.config.get('STORAGE_LOCAL_ROOT', { infer: true }));
        mkdirSync(localRoot, { recursive: true });
        accessSync(localRoot, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }

    if (driver === 's3') {
      return Boolean(
        this.config.get('S3_BUCKET', { infer: true }) &&
          this.config.get('S3_ACCESS_KEY_ID', { infer: true }) &&
          this.config.get('S3_SECRET_ACCESS_KEY', { infer: true }),
      );
    }

    if (driver === 'nextcloud') {
      return Boolean(
        this.config.get('NEXTCLOUD_URL', { infer: true }) &&
          this.config.get('NEXTCLOUD_USERNAME', { infer: true }) &&
          this.config.get('NEXTCLOUD_APP_PASSWORD', { infer: true }),
      );
    }

    return false;
  }
}

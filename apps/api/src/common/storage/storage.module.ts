import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvConfig } from '../../config/env.schema.js';
import { LocalStorageAdapter } from './local-storage.adapter.js';
import { NextcloudWebDavAdapter } from './nextcloud-webdav.adapter.js';
import { S3StorageAdapter } from './s3-storage.adapter.js';
import { STORAGE_PROVIDER, type StorageProvider } from './storage.interface.js';

@Global()
@Module({
  providers: [
    LocalStorageAdapter,
    S3StorageAdapter,
    NextcloudWebDavAdapter,
    {
      provide: STORAGE_PROVIDER,
      inject: [
        ConfigService,
        LocalStorageAdapter,
        S3StorageAdapter,
        NextcloudWebDavAdapter,
      ],
      useFactory: (
        config: ConfigService<EnvConfig, true>,
        local: LocalStorageAdapter,
        s3: S3StorageAdapter,
        nextcloud: NextcloudWebDavAdapter,
      ): StorageProvider => {
        const driver = config.get('STORAGE_DRIVER', { infer: true });
        if (driver === 's3') {
          return s3;
        }
        if (driver === 'nextcloud') {
          return nextcloud;
        }
        return local;
      },
    },
  ],
  exports: [STORAGE_PROVIDER, LocalStorageAdapter, S3StorageAdapter, NextcloudWebDavAdapter],
})
export class StorageModule {}

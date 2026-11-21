import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { StorageBucketCategory } from '@kestrel-it/shared';
import { Readable } from 'node:stream';
import type { EnvConfig } from '../../config/env.schema.js';
import {
  assertValidStorageCategory,
  bodyToBuffer,
  sanitizeStorageKey,
  type StorageObjectStreamResult,
  type StorageProvider,
} from './storage.interface.js';

@Injectable()
export class NextcloudWebDavAdapter implements StorageProvider {
  readonly driver = 'nextcloud' as const;
  private readonly initializedDirs = new Set<string>();

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  async putObject(
    category: StorageBucketCategory,
    key: string,
    body: Buffer | Readable,
    mimeType: string,
  ): Promise<void> {
    const cleanKey = sanitizeStorageKey(key);
    const settings = this.resolveNextcloudConfig();
    await this.ensureDirectoryHierarchy(settings, category, cleanKey);

    const objectUrl = this.buildWebDavObjectUrl(settings, category, cleanKey);
    const buffer = await bodyToBuffer(body);

    const response = await fetch(objectUrl, {
      method: 'PUT',
      headers: {
        authorization: settings.authHeader,
        'content-type': mimeType || 'application/octet-stream',
        'content-length': String(buffer.byteLength),
      },
      body: new Uint8Array(buffer),
    });

    if (!response.ok) {
      throw new BadGatewayException(`Nextcloud WebDAV PUT failed with status ${response.status}`);
    }
  }

  async getObjectStream(
    category: StorageBucketCategory,
    key: string,
  ): Promise<StorageObjectStreamResult> {
    assertValidStorageCategory(category);
    const cleanKey = sanitizeStorageKey(key);
    const settings = this.resolveNextcloudConfig();
    const objectUrl = this.buildWebDavObjectUrl(settings, category, cleanKey);

    const response = await fetch(objectUrl, {
      method: 'GET',
      headers: { authorization: settings.authHeader },
    });

    if (response.status === 404) {
      throw new NotFoundException(`Nextcloud WebDAV object not found: ${category}/${cleanKey}`);
    }
    if (!response.ok || !response.body) {
      throw new BadGatewayException(`Nextcloud WebDAV GET failed with status ${response.status}`);
    }

    const mimeType = response.headers.get('content-type') || 'application/octet-stream';
    const contentLengthHeader = response.headers.get('content-length');
    const size = contentLengthHeader ? Number(contentLengthHeader) : undefined;

    return {
      stream: Readable.fromWeb(
        response.body as unknown as import('node:stream/web').ReadableStream,
      ),
      mimeType,
      size: size !== undefined && Number.isFinite(size) ? size : undefined,
    };
  }

  async deleteObject(category: StorageBucketCategory, key: string): Promise<void> {
    assertValidStorageCategory(category);
    const cleanKey = sanitizeStorageKey(key);
    const settings = this.resolveNextcloudConfig();
    const objectUrl = this.buildWebDavObjectUrl(settings, category, cleanKey);

    const response = await fetch(objectUrl, {
      method: 'DELETE',
      headers: { authorization: settings.authHeader },
    });

    if (!response.ok && response.status !== 404) {
      throw new BadGatewayException(`Nextcloud WebDAV DELETE failed with status ${response.status}`);
    }
  }

  async exists(category: StorageBucketCategory, key: string): Promise<boolean> {
    assertValidStorageCategory(category);
    const cleanKey = sanitizeStorageKey(key);
    const settings = this.resolveNextcloudConfig();
    const objectUrl = this.buildWebDavObjectUrl(settings, category, cleanKey);

    const response = await fetch(objectUrl, {
      method: 'HEAD',
      headers: { authorization: settings.authHeader },
    });

    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      throw new BadGatewayException(`Nextcloud WebDAV HEAD failed with status ${response.status}`);
    }
    return true;
  }

  /**
   * Always returns an authenticated API proxy URL so Nextcloud credentials are never exposed to browsers.
   */
  async getSignedOrProxyUrl(
    category: StorageBucketCategory,
    key: string,
  ): Promise<string> {
    assertValidStorageCategory(category);
    const cleanKey = sanitizeStorageKey(key);
    const appUrl = this.config.get('APP_URL', { infer: true }).replace(/\/+$/, '');
    const apiPrefix = this.config.get('API_PREFIX', { infer: true }).replace(/^\/+|\/+$/g, '');
    const encodedKey = cleanKey.split('/').map(encodeURIComponent).join('/');
    return `${appUrl}/${apiPrefix}/storage/${category}/${encodedKey}`;
  }

  async checkHealth(): Promise<boolean> {
    const url = this.config.get('NEXTCLOUD_URL', { infer: true });
    const username = this.config.get('NEXTCLOUD_USERNAME', { infer: true });
    const appPassword = this.config.get('NEXTCLOUD_APP_PASSWORD', { infer: true });
    return Boolean(url && username && appPassword);
  }

  private async ensureDirectoryHierarchy(
    settings: ReturnType<NextcloudWebDavAdapter['resolveNextcloudConfig']>,
    category: StorageBucketCategory,
    cleanKey: string,
  ): Promise<void> {
    assertValidStorageCategory(category);

    const baseSegments = settings.basePath
      ? settings.basePath.split('/').filter((s) => s.length > 0)
      : [];
    const keyParts = cleanKey.split('/');
    const keyDirs = keyParts.slice(0, -1);

    const allDirSegments = [...baseSegments, category, ...keyDirs];
    let currentUrl = settings.davRoot;

    for (const seg of allDirSegments) {
      currentUrl = `${currentUrl}/${encodeURIComponent(seg)}`;
      if (this.initializedDirs.has(currentUrl)) {
        continue;
      }

      const mkcolRes = await fetch(currentUrl, {
        method: 'MKCOL',
        headers: { authorization: settings.authHeader },
      });

      // 201 Created, 405 Method Not Allowed (already exists)
      if (!mkcolRes.ok && mkcolRes.status !== 405) {
        throw new BadGatewayException(
          `Nextcloud WebDAV MKCOL failed for ${currentUrl} with status ${mkcolRes.status}`,
        );
      }

      this.initializedDirs.add(currentUrl);
    }
  }

  private buildWebDavObjectUrl(
    settings: ReturnType<NextcloudWebDavAdapter['resolveNextcloudConfig']>,
    category: StorageBucketCategory,
    cleanKey: string,
  ): string {
    assertValidStorageCategory(category);
    const baseSegments = settings.basePath
      ? settings.basePath.split('/').filter((s) => s.length > 0)
      : [];
    const keySegments = cleanKey.split('/');
    const path = [...baseSegments, category, ...keySegments].map(encodeURIComponent).join('/');
    return `${settings.davRoot}/${path}`;
  }

  private resolveNextcloudConfig() {
    const baseUrl = this.config.get('NEXTCLOUD_URL', { infer: true }).replace(/\/+$/, '');
    const username = this.config.get('NEXTCLOUD_USERNAME', { infer: true });
    const appPassword = this.config.get('NEXTCLOUD_APP_PASSWORD', { infer: true });
    const basePath = this.config
      .get('NEXTCLOUD_BASE_PATH', { infer: true })
      .replace(/^\/+|\/+$/g, '');

    if (!baseUrl || !username || !appPassword) {
      throw new BadRequestException(
        'Nextcloud storage driver requires NEXTCLOUD_URL, NEXTCLOUD_USERNAME, and NEXTCLOUD_APP_PASSWORD',
      );
    }

    const authHeader = `Basic ${Buffer.from(`${username}:${appPassword}`, 'utf8').toString('base64')}`;
    const davRoot = `${baseUrl}/remote.php/dav/files/${encodeURIComponent(username)}`;

    return { davRoot, basePath, authHeader };
  }
}

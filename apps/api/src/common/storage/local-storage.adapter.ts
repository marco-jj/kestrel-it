import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { StorageBucketCategory } from '@kestrel-it/shared';
import { constants, createReadStream } from 'node:fs';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { trimSlashes, trimTrailingCharacter } from '../string-utils.js';
import type { EnvConfig } from '../../config/env.schema.js';
import {
  assertValidStorageCategory,
  bodyToBuffer,
  sanitizeStorageKey,
  type StorageObjectStreamResult,
  type StorageProvider,
} from './storage.interface.js';

interface LocalObjectMetadata {
  mimeType: string;
  size: number;
  updatedAt: string;
}

@Injectable()
export class LocalStorageAdapter implements StorageProvider {
  readonly driver = 'local' as const;
  private readonly rootDir: string;
  private readonly metadataDir: string;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<EnvConfig, true>,
  ) {
    this.rootDir = resolve(this.config.get('STORAGE_LOCAL_ROOT', { infer: true }));
    this.metadataDir = join(this.rootDir, '.metadata');
  }

  async putObject(
    category: StorageBucketCategory,
    key: string,
    body: Buffer | Readable,
    mimeType: string,
  ): Promise<void> {
    const filePath = this.resolveSafeFilePath(category, key);
    const data = await bodyToBuffer(body);

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);

    const meta: LocalObjectMetadata = {
      mimeType: mimeType || 'application/octet-stream',
      size: data.byteLength,
      updatedAt: new Date().toISOString(),
    };
    const metadataPath = this.resolveMetadataPath(category, key);
    await mkdir(dirname(metadataPath), { recursive: true });
    await writeFile(metadataPath, JSON.stringify(meta), 'utf8');
  }

  async getObjectStream(
    category: StorageBucketCategory,
    key: string,
  ): Promise<StorageObjectStreamResult> {
    const filePath = this.resolveSafeFilePath(category, key);

    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      throw new NotFoundException(`Storage object not found: ${category}/${key}`);
    }

    if (!fileStat.isFile()) {
      throw new NotFoundException(`Storage object not found: ${category}/${key}`);
    }

    let mimeType = 'application/octet-stream';
    try {
      const rawMeta = await readFile(this.resolveMetadataPath(category, key), 'utf8').catch(
        async (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          // Preserve MIME types for objects written by older releases.
          return readFile(`${filePath}.meta.json`, 'utf8');
        },
      );
      const parsed = JSON.parse(rawMeta) as Partial<LocalObjectMetadata>;
      if (typeof parsed.mimeType === 'string' && parsed.mimeType &&
          parsed.size === fileStat.size && typeof parsed.updatedAt === 'string') {
        mimeType = parsed.mimeType;
      }
    } catch {
      // Fallback to octet-stream when sidecar metadata is absent
    }

    return {
      stream: createReadStream(filePath),
      mimeType,
      size: fileStat.size,
    };
  }

  async deleteObject(category: StorageBucketCategory, key: string): Promise<void> {
    const filePath = this.resolveSafeFilePath(category, key);
    await rm(filePath, { force: true });
    await rm(this.resolveMetadataPath(category, key), { force: true });
  }

  async exists(category: StorageBucketCategory, key: string): Promise<boolean> {
    const filePath = this.resolveSafeFilePath(category, key);
    try {
      const fileStat = await stat(filePath);
      return fileStat.isFile();
    } catch {
      return false;
    }
  }

  async getSignedOrProxyUrl(
    category: StorageBucketCategory,
    key: string,
  ): Promise<string> {
    assertValidStorageCategory(category);
    const cleanKey = sanitizeStorageKey(key);
    const appUrl = trimTrailingCharacter(this.config.get('APP_URL', { infer: true }), '/');
    const apiPrefix = trimSlashes(this.config.get('API_PREFIX', { infer: true }));
    const encodedKey = cleanKey.split('/').map(encodeURIComponent).join('/');
    return `${appUrl}/${apiPrefix}/storage/${category}/${encodedKey}`;
  }

  async checkHealth(): Promise<boolean> {
    try {
      await mkdir(this.rootDir, { recursive: true });
      await access(this.rootDir, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private resolveMetadataPath(category: StorageBucketCategory, key: string): string {
    return this.resolveSafeFilePath(category, key, this.metadataDir);
  }

  private resolveSafeFilePath(category: StorageBucketCategory, key: string, root = this.rootDir): string {
    assertValidStorageCategory(category);
    const cleanKey = sanitizeStorageKey(key);
    const categoryRoot = resolve(root, category);
    const resolvedPath = resolve(join(categoryRoot, cleanKey));

    if (!resolvedPath.startsWith(`${categoryRoot}${sep}`)) {
      throw new BadRequestException('Resolved storage path escapes bucket root');
    }
    return resolvedPath;
  }
}

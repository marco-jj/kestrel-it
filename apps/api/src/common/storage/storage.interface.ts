import { BadRequestException } from '@nestjs/common';
import {
  STORAGE_BUCKET_CATEGORIES,
  type StorageBucketCategory,
  type StorageDriver,
} from '@kestrel-it/shared';
import type { Readable } from 'node:stream';

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

export interface StorageObjectStreamResult {
  stream: Readable;
  mimeType: string;
  size?: number;
}

export interface StorageProvider {
  readonly driver: StorageDriver;

  putObject(
    category: StorageBucketCategory,
    key: string,
    body: Buffer | Readable,
    mimeType: string,
  ): Promise<void>;

  getObjectStream(
    category: StorageBucketCategory,
    key: string,
  ): Promise<StorageObjectStreamResult>;

  deleteObject(category: StorageBucketCategory, key: string): Promise<void>;

  exists(category: StorageBucketCategory, key: string): Promise<boolean>;

  getSignedOrProxyUrl(
    category: StorageBucketCategory,
    key: string,
    expiresInSeconds?: number,
  ): Promise<string>;

  checkHealth(): Promise<boolean>;
}

const VALID_CATEGORIES = new Set<string>(STORAGE_BUCKET_CATEGORIES);

/**
 * Validates that a bucket category and object key cannot escape their storage namespace.
 */
export function sanitizeStorageKey(key: string): string {
  if (typeof key !== 'string') {
    throw new BadRequestException('Storage key must be a string');
  }

  const trimmed = key.trim();
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('\\') || trimmed.startsWith('/')) {
    throw new BadRequestException('Invalid storage key');
  }

  const segments = trimmed.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new BadRequestException('Invalid path segment in storage key');
  }

  return segments.join('/');
}

export function assertValidStorageCategory(category: StorageBucketCategory): void {
  if (!VALID_CATEGORIES.has(category)) {
    throw new BadRequestException(`Unsupported storage category: ${String(category)}`);
  }
}

export async function bodyToBuffer(body: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(body)) {
    return body;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

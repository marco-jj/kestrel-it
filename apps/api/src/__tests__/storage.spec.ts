import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { StorageBucketCategory } from '@kestrel-it/shared';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../app.module.js';
import { LocalStorageAdapter } from '../common/storage/local-storage.adapter.js';
import { NextcloudWebDavAdapter } from '../common/storage/nextcloud-webdav.adapter.js';
import { S3StorageAdapter } from '../common/storage/s3-storage.adapter.js';
import {
  assertValidStorageCategory,
  bodyToBuffer,
  sanitizeStorageKey,
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../common/storage/storage.interface.js';
import { validateEnv } from '../config/env.schema.js';
import { DRIZZLE_DB } from '../db/database.tokens.js';

function makeConfigMock(overrides: Record<string, unknown> = {}) {
  const env = validateEnv({
    APP_ENCRYPTION_KEY: 'a'.repeat(64),
    JWT_SECRET: 'test-jwt-secret-minimum-16-chars-long',
    ...overrides,
  });
  return {
    get: (key: keyof typeof env) => env[key],
  } as unknown as ConstructorParameters<typeof LocalStorageAdapter>[0];
}

describe('NestJS AppModule DI bootstrap (DRIZZLE_DB TDZ fix & StorageModule)', () => {
  it('compiles AppModule without DRIZZLE_DB temporal dead zone ReferenceError and provides STORAGE_PROVIDER', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    try {
      const db = moduleRef.get(DRIZZLE_DB);
      const storage = moduleRef.get<StorageProvider>(STORAGE_PROVIDER);
      expect(db).toBeDefined();
      expect(storage).toBeInstanceOf(LocalStorageAdapter);
      expect(storage.driver).toBe('local');
    } finally {
      await moduleRef.close();
    }
  });
});

describe('Storage key sanitization & category validation', () => {
  it('rejects path traversal, backslashes, null bytes, leading slashes, and invalid categories', () => {
    expect(sanitizeStorageKey('2026/laptop-tag-01.png')).toBe('2026/laptop-tag-01.png');
    expect(() => sanitizeStorageKey('../etc/passwd')).toThrow(BadRequestException);
    expect(() => sanitizeStorageKey('assets/../../secret')).toThrow(BadRequestException);
    expect(() => sanitizeStorageKey('/etc/passwd')).toThrow(BadRequestException);
    expect(() => sanitizeStorageKey('folder\\file.png')).toThrow(BadRequestException);
    expect(() => sanitizeStorageKey('file.png\0.jpg')).toThrow(BadRequestException);
    expect(() => sanitizeStorageKey('')).toThrow(BadRequestException);

    expect(() => assertValidStorageCategory('assets')).not.toThrow();
    expect(() =>
      assertValidStorageCategory('unknown' as unknown as StorageBucketCategory),
    ).toThrow(BadRequestException);
  });
});

describe('LocalStorageAdapter', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('stores, streams, checks existence, generates proxy URL, and deletes objects on local disk', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'kestrel-storage-'));
    tempDirs.push(tempRoot);

    const adapter = new LocalStorageAdapter(
      makeConfigMock({
        APP_URL: 'https://assets.example.com',
        API_PREFIX: 'api/v1',
        STORAGE_LOCAL_ROOT: tempRoot,
      }),
    );

    expect(await adapter.checkHealth()).toBe(true);
    expect(await adapter.exists('assets', 'folder/photo.png')).toBe(false);

    // Put Buffer
    await adapter.putObject('assets', 'folder/photo.png', Buffer.from('png-binary'), 'image/png');
    expect(await adapter.exists('assets', 'folder/photo.png')).toBe(true);

    const downloaded = await adapter.getObjectStream('assets', 'folder/photo.png');
    expect(downloaded.mimeType).toBe('image/png');
    expect(downloaded.size).toBe(10);
    expect((await bodyToBuffer(downloaded.stream)).toString('utf8')).toBe('png-binary');

    // Put Readable stream
    await adapter.putObject(
      'eulas',
      'signed-01.pdf',
      Readable.from([Buffer.from('%PDF-1.7')]),
      'application/pdf',
    );
    const pdfStream = await adapter.getObjectStream('eulas', 'signed-01.pdf');
    expect(pdfStream.mimeType).toBe('application/pdf');
    expect((await bodyToBuffer(pdfStream.stream)).toString('utf8')).toBe('%PDF-1.7');

    expect(await adapter.getSignedOrProxyUrl('assets', 'folder/photo.png')).toBe(
      'https://assets.example.com/api/v1/storage/assets/folder/photo.png',
    );

    await adapter.deleteObject('assets', 'folder/photo.png');
    expect(await adapter.exists('assets', 'folder/photo.png')).toBe(false);
    await expect(adapter.getObjectStream('assets', 'folder/photo.png')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('keeps storage object keys independent from their metadata files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kestrel-storage-'));
    tempDirs.push(root);
    const adapter = new LocalStorageAdapter(makeConfigMock({ STORAGE_LOCAL_ROOT: root }));

    await adapter.putObject('assets', 'record.meta.json', Buffer.from('attachment'), 'text/plain');
    await adapter.putObject('assets', 'record', Buffer.from('record'), 'text/plain');
    await adapter.deleteObject('assets', 'record');

    const attachment = await adapter.getObjectStream('assets', 'record.meta.json');
    expect(attachment.mimeType).toBe('text/plain');
    expect((await bodyToBuffer(attachment.stream)).toString()).toBe('attachment');
  });
});

describe('S3StorageAdapter (AWS SigV4 & Presigned URLs)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('signs PUT/HEAD/GET/DELETE requests with AWS4-HMAC-SHA256 and generates Presigned URLs', async () => {
    const adapter = new S3StorageAdapter(
      makeConfigMock({
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'http://minio.local:9000',
        S3_REGION: 'eu-west-1',
        S3_BUCKET: 'kestrel-bucket',
        S3_ACCESS_KEY_ID: 'minioadmin',
        S3_SECRET_ACCESS_KEY: 'miniosecret123',
        S3_FORCE_PATH_STYLE: 'true',
      }),
    );

    expect(await adapter.checkHealth()).toBe(true);

    const fetchCalls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const headers = (init?.headers ?? {}) as Record<string, string>;
        fetchCalls.push({ url: String(input), method, headers });

        if (method === 'PUT') {
          return new Response(null, { status: 200 });
        }
        if (method === 'HEAD') {
          return new Response(null, { status: 200 });
        }
        if (method === 'GET') {
          return new Response('hello-s3', {
            status: 200,
            headers: { 'content-type': 'text/plain', 'content-length': '8' },
          });
        }
        if (method === 'DELETE') {
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      }),
    );

    await adapter.putObject('imports', 'batch-1.csv', Buffer.from('col1,col2'), 'text/csv');
    expect(fetchCalls[0]?.url).toBe('http://minio.local:9000/kestrel-bucket/imports/batch-1.csv');
    expect(fetchCalls[0]?.headers['Authorization']).toContain('AWS4-HMAC-SHA256 Credential=minioadmin/');
    expect(fetchCalls[0]?.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);

    expect(await adapter.exists('imports', 'batch-1.csv')).toBe(true);

    const streamed = await adapter.getObjectStream('imports', 'batch-1.csv');
    expect(streamed.mimeType).toBe('text/plain');
    expect(streamed.size).toBe(8);
    expect((await bodyToBuffer(streamed.stream)).toString('utf8')).toBe('hello-s3');

    await adapter.deleteObject('imports', 'batch-1.csv');
    expect(fetchCalls.map((c) => c.method)).toEqual(['PUT', 'HEAD', 'GET', 'DELETE']);

    const fixedDate = new Date('2026-11-21T12:00:00Z');
    const presigned = await adapter.getSignedOrProxyUrl('assets', 'tag 1.png', 300, fixedDate);
    const parsedUrl = new URL(presigned);
    expect(parsedUrl.origin).toBe('http://minio.local:9000');
    expect(parsedUrl.pathname).toBe('/kestrel-bucket/assets/tag%201.png');
    expect(parsedUrl.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(parsedUrl.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(parsedUrl.searchParams.get('X-Amz-Date')).toBe('20261121T120000Z');
    expect(parsedUrl.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('supports virtual-hosted-style URLs and throws NotFoundException on HTTP 404', async () => {
    const adapter = new S3StorageAdapter(
      makeConfigMock({
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'https://s3.eu-central-1.amazonaws.com',
        S3_REGION: 'eu-central-1',
        S3_BUCKET: 'corp-kestrel',
        S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        S3_SECRET_ACCESS_KEY: 'secretkeyexample',
        S3_FORCE_PATH_STYLE: 'false',
      }),
    );

    const url = await adapter.getSignedOrProxyUrl('branding', 'logo.svg', 60);
    expect(url.startsWith('https://corp-kestrel.s3.eu-central-1.amazonaws.com/branding/logo.svg?')).toBe(
      true,
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    expect(await adapter.exists('branding', 'missing.svg')).toBe(false);
    await expect(adapter.getObjectStream('branding', 'missing.svg')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('NextcloudWebDavAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates WebDAV directories with MKCOL, authenticates via Basic Auth, and returns safe proxy URL', async () => {
    const adapter = new NextcloudWebDavAdapter(
      makeConfigMock({
        APP_URL: 'https://kestrel.corp.local',
        API_PREFIX: 'api/v1',
        STORAGE_DRIVER: 'nextcloud',
        NEXTCLOUD_URL: 'https://cloud.corp.local',
        NEXTCLOUD_USERNAME: 'kestrel-bot',
        NEXTCLOUD_APP_PASSWORD: 'nc-secret-app-password',
        NEXTCLOUD_BASE_PATH: '/itam-files',
      }),
    );

    expect(await adapter.checkHealth()).toBe(true);

    const calls: Array<{ url: string; method: string; auth?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ url: String(input), method, auth: headers['authorization'] });

        if (method === 'MKCOL') {
          return new Response(null, { status: 201 });
        }
        if (method === 'PUT') {
          return new Response(null, { status: 201 });
        }
        if (method === 'HEAD') {
          return new Response(null, { status: 200 });
        }
        if (method === 'GET') {
          return new Response('audit-image-bytes', {
            status: 200,
            headers: { 'content-type': 'image/jpeg', 'content-length': '17' },
          });
        }
        if (method === 'DELETE') {
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      }),
    );

    await adapter.putObject(
      'audits',
      '2026/check.jpg',
      Buffer.from('audit-image-bytes'),
      'image/jpeg',
    );

    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['MKCOL', 'https://cloud.corp.local/remote.php/dav/files/kestrel-bot/itam-files'],
      ['MKCOL', 'https://cloud.corp.local/remote.php/dav/files/kestrel-bot/itam-files/audits'],
      ['MKCOL', 'https://cloud.corp.local/remote.php/dav/files/kestrel-bot/itam-files/audits/2026'],
      [
        'PUT',
        'https://cloud.corp.local/remote.php/dav/files/kestrel-bot/itam-files/audits/2026/check.jpg',
      ],
    ]);
    expect(calls[0]?.auth).toBe(
      `Basic ${Buffer.from('kestrel-bot:nc-secret-app-password').toString('base64')}`,
    );

    expect(await adapter.exists('audits', '2026/check.jpg')).toBe(true);

    const downloaded = await adapter.getObjectStream('audits', '2026/check.jpg');
    expect(downloaded.mimeType).toBe('image/jpeg');
    expect((await bodyToBuffer(downloaded.stream)).toString('utf8')).toBe('audit-image-bytes');

    // Second PUT in the same directory reuses in-memory MKCOL cache
    calls.length = 0;
    await adapter.putObject('audits', '2026/check-2.jpg', Buffer.from('ok'), 'image/jpeg');
    expect(calls.map((c) => c.method)).toEqual(['PUT']);

    const proxyUrl = await adapter.getSignedOrProxyUrl('audits', '2026/check.jpg');
    expect(proxyUrl).toBe('https://kestrel.corp.local/api/v1/storage/audits/2026/check.jpg');
    expect(proxyUrl).not.toContain('nc-secret-app-password');
    expect(proxyUrl).not.toContain('cloud.corp.local');

    await adapter.deleteObject('audits', '2026/check.jpg');
  });
});

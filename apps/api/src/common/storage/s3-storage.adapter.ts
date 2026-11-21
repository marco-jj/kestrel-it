import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { StorageBucketCategory } from '@kestrel-it/shared';
import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import type { EnvConfig } from '../../config/env.schema.js';
import {
  assertValidStorageCategory,
  bodyToBuffer,
  sanitizeStorageKey,
  type StorageObjectStreamResult,
  type StorageProvider,
} from './storage.interface.js';

const EMPTY_PAYLOAD_HASH =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function formatAmzDates(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

@Injectable()
export class S3StorageAdapter implements StorageProvider {
  readonly driver = 's3' as const;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  async putObject(
    category: StorageBucketCategory,
    key: string,
    body: Buffer | Readable,
    mimeType: string,
  ): Promise<void> {
    const buffer = await bodyToBuffer(body);
    const payloadHash = sha256Hex(buffer);
    const { url, headers } = this.signRequest({
      method: 'PUT',
      category,
      key,
      payloadHash,
      extraHeaders: {
        'content-type': mimeType || 'application/octet-stream',
        'content-length': String(buffer.byteLength),
      },
    });

    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: new Uint8Array(buffer),
    });

    if (!response.ok) {
      throw new BadGatewayException(`S3 PUT failed with status ${response.status}`);
    }
  }

  async getObjectStream(
    category: StorageBucketCategory,
    key: string,
  ): Promise<StorageObjectStreamResult> {
    const { url, headers } = this.signRequest({
      method: 'GET',
      category,
      key,
      payloadHash: EMPTY_PAYLOAD_HASH,
    });

    const response = await fetch(url, { method: 'GET', headers });
    if (response.status === 404) {
      throw new NotFoundException(`S3 object not found: ${category}/${key}`);
    }
    if (!response.ok || !response.body) {
      throw new BadGatewayException(`S3 GET failed with status ${response.status}`);
    }

    const mimeType = response.headers.get('content-type') || 'application/octet-stream';
    const contentLengthHeader = response.headers.get('content-length');
    const size = contentLengthHeader ? Number(contentLengthHeader) : undefined;

    const stream = Readable.fromWeb(
      response.body as unknown as import('node:stream/web').ReadableStream,
    );

    return {
      stream,
      mimeType,
      size: size !== undefined && Number.isFinite(size) ? size : undefined,
    };
  }

  async deleteObject(category: StorageBucketCategory, key: string): Promise<void> {
    const { url, headers } = this.signRequest({
      method: 'DELETE',
      category,
      key,
      payloadHash: EMPTY_PAYLOAD_HASH,
    });

    const response = await fetch(url, { method: 'DELETE', headers });
    if (!response.ok && response.status !== 404) {
      throw new BadGatewayException(`S3 DELETE failed with status ${response.status}`);
    }
  }

  async exists(category: StorageBucketCategory, key: string): Promise<boolean> {
    const { url, headers } = this.signRequest({
      method: 'HEAD',
      category,
      key,
      payloadHash: EMPTY_PAYLOAD_HASH,
    });

    const response = await fetch(url, { method: 'HEAD', headers });
    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      throw new BadGatewayException(`S3 HEAD failed with status ${response.status}`);
    }
    return true;
  }

  async getSignedOrProxyUrl(
    category: StorageBucketCategory,
    key: string,
    expiresInSeconds = 900,
    now: Date = new Date(),
  ): Promise<string> {
    const settings = this.resolveS3Config();
    const objectUrl = this.buildObjectUrl(settings, category, key);
    const { amzDate, dateStamp } = formatAmzDates(now);
    const credentialScope = `${dateStamp}/${settings.region}/s3/aws4_request`;
    const clampedExpires = Math.max(1, Math.min(604_800, Math.floor(expiresInSeconds)));

    const queryPairs: Array<[string, string]> = [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${settings.accessKeyId}/${credentialScope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(clampedExpires)],
      ['X-Amz-SignedHeaders', 'host'],
    ];

    const canonicalQuery = queryPairs
      .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
      .sort()
      .join('&');

    const canonicalHeaders = `host:${objectUrl.host}\n`;
    const canonicalRequest = [
      'GET',
      objectUrl.pathname,
      canonicalQuery,
      canonicalHeaders,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = this.deriveSigningKey(settings.secretAccessKey, dateStamp, settings.region);
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    return `${objectUrl.origin}${objectUrl.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  async checkHealth(): Promise<boolean> {
    const bucket = this.config.get('S3_BUCKET', { infer: true });
    const accessKeyId = this.config.get('S3_ACCESS_KEY_ID', { infer: true });
    const secretAccessKey = this.config.get('S3_SECRET_ACCESS_KEY', { infer: true });
    return Boolean(bucket && accessKeyId && secretAccessKey);
  }

  private signRequest(params: {
    method: 'PUT' | 'GET' | 'DELETE' | 'HEAD';
    category: StorageBucketCategory;
    key: string;
    payloadHash: string;
    extraHeaders?: Record<string, string>;
    now?: Date;
  }): { url: string; headers: Record<string, string> } {
    const settings = this.resolveS3Config();
    const objectUrl = this.buildObjectUrl(settings, params.category, params.key);
    const { amzDate, dateStamp } = formatAmzDates(params.now ?? new Date());
    const credentialScope = `${dateStamp}/${settings.region}/s3/aws4_request`;

    const headersLower: Record<string, string> = {
      host: objectUrl.host,
      'x-amz-content-sha256': params.payloadHash,
      'x-amz-date': amzDate,
    };

    if (params.extraHeaders) {
      for (const [k, v] of Object.entries(params.extraHeaders)) {
        headersLower[k.toLowerCase()] = v.trim();
      }
    }

    const sortedKeys = Object.keys(headersLower).sort();
    const canonicalHeaders = sortedKeys.map((k) => `${k}:${headersLower[k]}\n`).join('');
    const signedHeaders = sortedKeys.join(';');

    const canonicalRequest = [
      params.method,
      objectUrl.pathname,
      '',
      canonicalHeaders,
      signedHeaders,
      params.payloadHash,
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = this.deriveSigningKey(settings.secretAccessKey, dateStamp, settings.region);
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${settings.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const outboundHeaders: Record<string, string> = {};
    for (const k of sortedKeys) {
      if (k !== 'host') {
        outboundHeaders[k] = headersLower[k]!;
      }
    }
    outboundHeaders['Authorization'] = authorization;

    return {
      url: objectUrl.toString(),
      headers: outboundHeaders,
    };
  }

  private deriveSigningKey(secretAccessKey: string, dateStamp: string, region: string): Buffer {
    const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
    const kRegion = hmacSha256(kDate, region);
    const kService = hmacSha256(kRegion, 's3');
    return hmacSha256(kService, 'aws4_request');
  }

  private resolveS3Config() {
    const region = this.config.get('S3_REGION', { infer: true }) || 'us-east-1';
    const bucket = this.config.get('S3_BUCKET', { infer: true });
    const accessKeyId = this.config.get('S3_ACCESS_KEY_ID', { infer: true });
    const secretAccessKey = this.config.get('S3_SECRET_ACCESS_KEY', { infer: true });
    const forcePathStyle = this.config.get('S3_FORCE_PATH_STYLE', { infer: true });
    const endpoint =
      this.config.get('S3_ENDPOINT', { infer: true }) ||
      `https://s3.${region}.amazonaws.com`;

    if (!bucket || !accessKeyId || !secretAccessKey) {
      throw new BadRequestException(
        'S3 storage driver requires S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY',
      );
    }

    return {
      endpoint: endpoint.replace(/\/+$/, ''),
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
      forcePathStyle,
    };
  }

  private buildObjectUrl(
    settings: ReturnType<S3StorageAdapter['resolveS3Config']>,
    category: StorageBucketCategory,
    key: string,
  ): URL {
    assertValidStorageCategory(category);
    const cleanKey = sanitizeStorageKey(key);
    const encodedKey = cleanKey.split('/').map(encodeRfc3986).join('/');
    const base = new URL(settings.endpoint);
    const basePath = base.pathname.replace(/\/+$/, '');

    if (settings.forcePathStyle) {
      return new URL(`${base.origin}${basePath}/${encodeRfc3986(settings.bucket)}/${category}/${encodedKey}`);
    }

    const virtualHost = `${settings.bucket}.${base.host}`;
    return new URL(`${base.protocol}//${virtualHost}${basePath}/${category}/${encodedKey}`);
  }
}

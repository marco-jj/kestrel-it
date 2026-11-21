import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import type { EnvConfig } from '../../config/env.schema.js';

const ENC_PREFIX = 'enc:v1:';

@Injectable()
export class CryptoService {
  private readonly encryptionKey: Buffer;

  constructor(@Inject(ConfigService) config: ConfigService<EnvConfig, true>) {
    const keyHex = config.get('APP_ENCRYPTION_KEY', { infer: true });
    if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
      throw new Error('APP_ENCRYPTION_KEY must be a 64-character hex string');
    }
    this.encryptionKey = Buffer.from(keyHex, 'hex');
  }

  /**
   * Encrypts sensitive values (2FA secrets, OIDC client secrets, encrypted custom fields) using AES-256-GCM.
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${ENC_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /**
   * Decrypts values encrypted by encrypt().
   */
  decrypt(payload: string): string {
    if (!payload.startsWith(ENC_PREFIX)) {
      throw new Error('Invalid encrypted payload format');
    }
    const parts = payload.slice(ENC_PREFIX.length).split(':');
    if (parts.length !== 3) {
      throw new Error('Malformed encrypted payload');
    }
    const [ivHex, authTagHex, cipherHex] = parts as [string, string, string];
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const ciphertext = Buffer.from(cipherHex, 'hex');

    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /**
   * Hashes passwords using Node native scrypt with a random 16-byte salt.
   */
  hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const derivedKey = scryptSync(password, salt, 64).toString('hex');
    return `scrypt:${salt}:${derivedKey}`;
  }

  /**
   * Verifies both Kestrel-IT scrypt hashes and legacy Snipe-IT Laravel bcrypt ($2y$/$2a$/$2b$) hashes.
   */
  async verifyPassword(password: string, storedHash: string): Promise<boolean> {
    if (!storedHash) {
      return false;
    }

    if (storedHash.startsWith('scrypt:')) {
      const [, salt, hashHex] = storedHash.split(':');
      if (!salt || !hashHex) {
        return false;
      }
      const expectedBuffer = Buffer.from(hashHex, 'hex');
      const actualBuffer = scryptSync(password, salt, 64);
      if (expectedBuffer.length !== actualBuffer.length) {
        return false;
      }
      return timingSafeEqual(expectedBuffer, actualBuffer);
    }

    if (/^\$2[aby]\$/.test(storedHash)) {
      const normalized = storedHash.replace(/^\$2y\$/, '$2a$');
      return bcrypt.compare(password, normalized);
    }

    return false;
  }

  sha256Hex(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  /**
   * Generates a prefixed Personal Access Token (`kst_...`) and its SHA-256 database digest.
   */
  generatePatToken(): { token: string; tokenHash: string } {
    const raw = randomBytes(32).toString('base64url');
    const token = `kst_${raw}`;
    return {
      token,
      tokenHash: this.sha256Hex(token),
    };
  }
}

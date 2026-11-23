import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { trimTrailingCharacter } from '../string-utils.js';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31]!;
  }

  return output;
}

export function base32Decode(input: string): Buffer {
  const cleaned = trimTrailingCharacter(input.toUpperCase(), '=').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) {
      throw new Error(`Invalid Base32 character: ${char}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * Generates a Base32-encoded TOTP secret (default 160 bits).
 */
export function generateBase32Secret(byteLength = 20): string {
  return base32Encode(randomBytes(byteLength));
}

export function buildOtpAuthUri(params: {
  issuer: string;
  accountName: string;
  secret: string;
}): string {
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.accountName)}`;
  const issuerParam = encodeURIComponent(params.issuer);
  return `otpauth://totp/${label}?secret=${encodeURIComponent(params.secret)}&issuer=${issuerParam}&algorithm=SHA1&digits=6&period=30`;
}

/**
 * Generates an RFC 6238 6-digit TOTP code (HMAC-SHA1, 30s period).
 */
export function generateTotpCode(
  secretBase32: string,
  timestampMs = Date.now(),
  stepSeconds = 30,
): string {
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', secret).update(counterBuffer).digest();
  const offset = digest.at(-1)! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  const otp = binary % 1_000_000;
  return otp.toString().padStart(6, '0');
}

/**
 * Verifies a 6-digit TOTP code allowing a +/- window of 30s intervals.
 */
export function verifyTotpCode(
  secretBase32: string,
  code: string,
  window = 1,
  timestampMs = Date.now(),
  stepSeconds = 30,
): boolean {
  const normalizedCode = code.trim();
  if (!/^\d{6}$/.test(normalizedCode)) {
    return false;
  }

  let matched = false;
  const submittedBuf = Buffer.from(normalizedCode, 'utf8');

  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = generateTotpCode(
      secretBase32,
      timestampMs + offset * stepSeconds * 1000,
      stepSeconds,
    );
    const candidateBuf = Buffer.from(candidate, 'utf8');
    if (timingSafeEqual(submittedBuf, candidateBuf)) {
      matched = true;
    }
  }

  return matched;
}

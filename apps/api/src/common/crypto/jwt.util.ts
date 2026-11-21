import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { randomUUID } from 'node:crypto';
import type { EnvConfig } from '../../config/env.schema.js';

export type AppTokenType = 'access' | 'refresh' | '2fa_challenge' | 'oidc_state';

export interface AccessTokenPayload extends JWTPayload {
  sub: string;
  type: 'access';
  username: string;
  twoFactorVerified: boolean;
}

export interface RefreshTokenPayload extends JWTPayload {
  sub: string;
  type: 'refresh';
  jti?: string;
}

export interface TwoFactorChallengePayload extends JWTPayload {
  sub: string;
  type: '2fa_challenge';
  requiresEnrollment: boolean;
}

export interface OidcStatePayload extends JWTPayload {
  type: 'oidc_state';
  state: string;
  nonce: string;
  codeVerifier: string;
}

@Injectable()
export class JwtService {
  private readonly secretKey: Uint8Array;
  private readonly accessExpiresIn: string;
  private readonly refreshExpiresIn: string;
  private readonly jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  constructor(@Inject(ConfigService) config: ConfigService<EnvConfig, true>) {
    const secret = config.get('JWT_SECRET', { infer: true });
    this.secretKey = new TextEncoder().encode(secret);
    this.accessExpiresIn = config.get('JWT_ACCESS_EXPIRES_IN', { infer: true });
    this.refreshExpiresIn = config.get('JWT_REFRESH_EXPIRES_IN', { infer: true });
  }

  async signAccessToken(params: {
    userId: number;
    username: string;
    twoFactorVerified: boolean;
  }): Promise<string> {
    return new SignJWT({
      type: 'access',
      username: params.username,
      twoFactorVerified: params.twoFactorVerified,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(params.userId))
      .setIssuedAt()
      .setExpirationTime(this.accessExpiresIn)
      .sign(this.secretKey);
  }

  async signRefreshToken(params: { userId: number; jti?: string }): Promise<string> {
    return new SignJWT({ type: 'refresh' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(params.userId))
      .setJti(params.jti ?? randomUUID())
      .setIssuedAt()
      .setExpirationTime(this.refreshExpiresIn)
      .sign(this.secretKey);
  }

  async signTwoFactorChallenge(params: {
    userId: number;
    requiresEnrollment: boolean;
  }): Promise<string> {
    return new SignJWT({
      type: '2fa_challenge',
      requiresEnrollment: params.requiresEnrollment,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(params.userId))
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(this.secretKey);
  }

  async signOidcState(params: {
    state: string;
    nonce: string;
    codeVerifier: string;
  }): Promise<string> {
    return new SignJWT({
      type: 'oidc_state',
      state: params.state,
      nonce: params.nonce,
      codeVerifier: params.codeVerifier,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(this.secretKey);
  }

  async verifyToken<T extends JWTPayload & { type: AppTokenType }>(
    token: string,
    expectedType: AppTokenType,
  ): Promise<T> {
    try {
      const { payload } = await jwtVerify(token, this.secretKey, {
        algorithms: ['HS256'],
      });
      if (payload['type'] !== expectedType) {
        throw new UnauthorizedException('Invalid token type');
      }
      return payload as T;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  async verifyOidcIdToken(
    idToken: string,
    options: {
      issuerUrl: string;
      clientId: string;
      jwksUri: string;
      expectedNonce?: string;
    },
  ): Promise<Record<string, unknown>> {
    let jwks = this.jwksCache.get(options.jwksUri);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(options.jwksUri));
      this.jwksCache.set(options.jwksUri, jwks);
    }

    try {
      const { payload } = await jwtVerify(idToken, jwks, {
        issuer: options.issuerUrl,
        audience: options.clientId,
      });

      if (options.expectedNonce && payload['nonce'] !== options.expectedNonce) {
        throw new UnauthorizedException('OIDC ID token nonce mismatch');
      }

      return payload as Record<string, unknown>;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Failed to verify OIDC ID token');
    }
  }
}

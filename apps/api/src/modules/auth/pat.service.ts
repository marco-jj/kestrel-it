import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  AuthenticatedUserContext,
  CreatePatRequest,
  CreatePatResponse,
  PatSummary,
} from '@kestrel-it/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import { personalAccessTokens } from '../../db/schema/index.js';
import { AuthService } from './auth.service.js';

@Injectable()
export class PatService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(CryptoService) private readonly cryptoService: CryptoService,
    @Inject(AuthService) private readonly authService: AuthService,
  ) {}

  async listUserTokens(user: AuthenticatedUserContext): Promise<PatSummary[]> {
    this.assertCanManageTokens(user);

    const rows = await this.db
      .select()
      .from(personalAccessTokens)
      .where(
        and(eq(personalAccessTokens.userId, user.id), isNull(personalAccessTokens.revokedAt)),
      )
      .orderBy(desc(personalAccessTokens.createdAt));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async createToken(
    user: AuthenticatedUserContext,
    dto: CreatePatRequest,
  ): Promise<CreatePatResponse> {
    this.assertCanManageTokens(user);

    const { token, tokenHash } = this.cryptoService.generatePatToken();
    const expiresAtDate = dto.expiresAt ? new Date(dto.expiresAt) : null;

    const [created] = await this.db
      .insert(personalAccessTokens)
      .values({
        userId: user.id,
        name: dto.name,
        tokenHash,
        scopes: [],
        expiresAt: expiresAtDate,
      })
      .returning();

    if (!created) {
      throw new Error('Failed to persist personal access token');
    }

    return {
      id: created.id,
      name: created.name,
      token,
      lastUsedAt: null,
      expiresAt: created.expiresAt ? created.expiresAt.toISOString() : null,
      createdAt: created.createdAt.toISOString(),
    };
  }

  async revokeToken(user: AuthenticatedUserContext, tokenId: string): Promise<void> {
    this.assertCanManageTokens(user);

    const [existing] = await this.db
      .select({ id: personalAccessTokens.id })
      .from(personalAccessTokens)
      .where(
        and(
          eq(personalAccessTokens.id, tokenId),
          eq(personalAccessTokens.userId, user.id),
          isNull(personalAccessTokens.revokedAt),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new NotFoundException('Personal access token not found');
    }

    await this.db
      .update(personalAccessTokens)
      .set({ revokedAt: new Date() })
      .where(eq(personalAccessTokens.id, existing.id));
  }

  async authenticatePat(rawToken: string): Promise<AuthenticatedUserContext> {
    const tokenHash = this.cryptoService.sha256Hex(rawToken);
    const [row] = await this.db
      .select()
      .from(personalAccessTokens)
      .where(
        and(eq(personalAccessTokens.tokenHash, tokenHash), isNull(personalAccessTokens.revokedAt)),
      )
      .limit(1);

    if (!row) {
      throw new UnauthorizedException('Invalid or revoked personal access token');
    }

    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Personal access token has expired');
    }

    await this.db
      .update(personalAccessTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(personalAccessTokens.id, row.id));

    return this.authService.loadUserContext(row.userId, true, 'pat');
  }

  private assertCanManageTokens(user: AuthenticatedUserContext): void {
    if (user.effectivePermissions['self.api'] !== true) {
      throw new ForbiddenException('Missing self.api permission');
    }
    if (!user.twoFactorVerified) {
      throw new ForbiddenException('Two-factor authentication must be completed');
    }
  }
}

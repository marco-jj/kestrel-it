import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { TWO_FACTOR_POLICY, type AuthenticatedUserContext, type LoginResponse } from '@kestrel-it/shared';
import {
  getTableColumns,
  getTableName,
  type Column,
  type SQL,
  type Table,
} from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { PgDialect } from 'drizzle-orm/pg-core';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../app.module.js';
import { CryptoService } from '../common/crypto/crypto.service.js';
import { JwtService } from '../common/crypto/jwt.util.js';
import { generateTotpCode } from '../common/crypto/totp.util.js';
import { validateEnv } from '../config/env.schema.js';
import { DRIZZLE_DB, POSTGRES_CLIENT, type DrizzleDb } from '../db/database.tokens.js';
import { AuthService } from '../modules/auth/auth.service.js';
import { BetterAuthService } from '../modules/auth/better-auth.service.js';
import { OidcUserProvisioningService } from '../modules/auth/oidc-provisioning.service.js';

type RowRecord = Record<string, unknown>;

function buildColumnMap(table: Table): Map<string, { prop: string; col: Column }> {
  const map = new Map<string, { prop: string; col: Column }>();
  const cols = getTableColumns(table) as Record<string, Column>;
  for (const [prop, col] of Object.entries(cols)) {
    map.set(col.name, { prop, col });
  }
  return map;
}

function splitTopLevelAnd(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingleQuote = false;
  let current = '';

  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i]!;
    if (ch === "'" && expr[i - 1] !== '\\') {
      inSingleQuote = !inSingleQuote;
    }
    if (!inSingleQuote) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (depth === 0 && expr.slice(i, i + 5).toLowerCase() === ' and ') {
        parts.push(current.trim());
        current = '';
        i += 4;
        continue;
      }
    }
    current += ch;
  }
  if (current.trim().length > 0) {
    parts.push(current.trim());
  }
  return parts;
}

function stripOuterParens(expr: string): string {
  let trimmed = expr.trim();
  while (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    let depth = 0;
    let wrappedWhole = true;
    for (let i = 0; i < trimmed.length; i += 1) {
      if (trimmed[i] === '(') depth += 1;
      else if (trimmed[i] === ')') depth -= 1;
      if (depth === 0 && i < trimmed.length - 1) {
        wrappedWhole = false;
        break;
      }
    }
    if (!wrappedWhole) {
      break;
    }
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Lightweight relational in-memory Drizzle harness using PgDialect SQL rendering
 * so real Drizzle queries (`eq`, `and`, `isNull`, `inArray`, `count`, `innerJoin`, `transaction`)
 * run deterministically without requiring an external PostgreSQL daemon.
 */
function createInMemoryDrizzleHarness() {
  const dialect = new PgDialect();
  const store = new Map<string, RowRecord[]>();
  const sequences = new Map<string, number>();

  const nextId = (tableName: string): number => {
    const next = (sequences.get(tableName) ?? 0) + 1;
    sequences.set(tableName, next);
    return next;
  };

  const getRows = (table: Table): RowRecord[] => {
    const name = getTableName(table);
    let rows = store.get(name);
    if (!rows) {
      rows = [];
      store.set(name, rows);
    }
    return rows;
  };

  const resolveColumnProp = (
    table: Table,
    tableQualifier: string | undefined,
    colName: string,
    extraTables: Table[] = [],
  ): { targetTableName: string; prop: string } | null => {
    const candidates = [table, ...extraTables];
    for (const candidate of candidates) {
      const candidateName = getTableName(candidate);
      if (tableQualifier && candidateName !== tableQualifier) {
        continue;
      }
      const entry = buildColumnMap(candidate).get(colName);
      if (entry) {
        return { targetTableName: candidateName, prop: entry.prop };
      }
    }
    return null;
  };

  const matchesWhere = (
    rowByTable: Map<string, RowRecord>,
    primaryTable: Table,
    whereExpr: SQL | undefined,
    extraTables: Table[] = [],
  ): boolean => {
    if (!whereExpr) {
      return true;
    }
    const { sql: rawSql, params } = dialect.sqlToQuery(whereExpr);
    const evaluateExpr = (clause: string): boolean => {
      const normalized = stripOuterParens(clause);
      const clauses = splitTopLevelAnd(normalized);
      if (clauses.length > 1) {
        return clauses.every((part) => evaluateExpr(part));
      }

      const isNullMatch = normalized.match(/^(?:"([^"]+)"\.)?"([^"]+)"\s+is\s+null$/i);
      if (isNullMatch) {
        const resolved = resolveColumnProp(primaryTable, isNullMatch[1], isNullMatch[2]!, extraTables);
        if (!resolved) return false;
        const val = rowByTable.get(resolved.targetTableName)?.[resolved.prop];
        return val === null || val === undefined;
      }

      const eqParamMatch = normalized.match(/^(?:"([^"]+)"\.)?"([^"]+)"\s*=\s*\$(\d+)$/i);
      if (eqParamMatch) {
        const resolved = resolveColumnProp(
          primaryTable,
          eqParamMatch[1],
          eqParamMatch[2]!,
          extraTables,
        );
        if (!resolved) return false;
        const expected = params[Number(eqParamMatch[3]) - 1];
        const actual = rowByTable.get(resolved.targetTableName)?.[resolved.prop];
        return actual === expected;
      }

      const eqColMatch = normalized.match(
        /^(?:"([^"]+)"\.)?"([^"]+)"\s*=\s*(?:"([^"]+)"\.)?"([^"]+)"$/i,
      );
      if (eqColMatch) {
        const left = resolveColumnProp(primaryTable, eqColMatch[1], eqColMatch[2]!, extraTables);
        const right = resolveColumnProp(primaryTable, eqColMatch[3], eqColMatch[4]!, extraTables);
        if (!left || !right) return false;
        const leftVal = rowByTable.get(left.targetTableName)?.[left.prop];
        const rightVal = rowByTable.get(right.targetTableName)?.[right.prop];
        return leftVal === rightVal;
      }

      const inMatch = normalized.match(/^(?:"([^"]+)"\.)?"([^"]+)"\s+in\s+\(([^)]+)\)$/i);
      if (inMatch) {
        const resolved = resolveColumnProp(primaryTable, inMatch[1], inMatch[2]!, extraTables);
        if (!resolved) return false;
        const actual = rowByTable.get(resolved.targetTableName)?.[resolved.prop];
        const placeholders = [...inMatch[3]!.matchAll(/\$(\d+)/g)].map(
          (m) => params[Number(m[1]) - 1],
        );
        return placeholders.includes(actual);
      }

      throw new Error(`Unsupported SQL predicate in in-memory Drizzle harness: ${normalized}`);
    };

    return evaluateExpr(rawSql);
  };

  const applyDefaults = (table: Table, rawRow: RowRecord): RowRecord => {
    const tableName = getTableName(table);
    const cols = getTableColumns(table) as Record<string, Column>;
    const row: RowRecord = { ...rawRow };
    const now = new Date();

    for (const [prop, col] of Object.entries(cols)) {
      if (row[prop] !== undefined) {
        continue;
      }
      if (prop === 'id') {
        if (col.dataType === 'string') {
          row[prop] = randomUUID();
        } else if (col.dataType === 'number') {
          row[prop] = nextId(tableName);
        }
        continue;
      }
      if (prop === 'createdAt' || prop === 'updatedAt') {
        row[prop] = now;
        continue;
      }
      if (col.hasDefault && col.default !== undefined && typeof col.default !== 'function') {
        try {
          row[prop] = structuredClone(col.default);
        } catch {
          row[prop] = col.default;
        }
        continue;
      }
      row[prop] = null;
    }

    if (row['id'] !== undefined && typeof row['id'] === 'number') {
      const currentSeq = sequences.get(tableName) ?? 0;
      if (row['id'] > currentSeq) {
        sequences.set(tableName, row['id']);
      }
    }

    return row;
  };

  const projectRow = (
    projection: Record<string, unknown> | undefined,
    rowByTable: Map<string, RowRecord>,
    baseTable: Table,
  ): RowRecord => {
    if (!projection) {
      return { ...(rowByTable.get(getTableName(baseTable)) ?? {}) };
    }
    const out: RowRecord = {};
    for (const [alias, expr] of Object.entries(projection)) {
      const colExpr = expr as { table?: Table; name?: string };
      if (colExpr?.table && colExpr.name) {
        const tName = getTableName(colExpr.table);
        const colInfo = buildColumnMap(colExpr.table).get(colExpr.name);
        if (colInfo) {
          out[alias] = rowByTable.get(tName)?.[colInfo.prop] ?? null;
          continue;
        }
      }
      out[alias] = rowByTable.get(getTableName(baseTable))?.[alias] ?? null;
    }
    return out;
  };

  const appliedMigrations = readMigrationFiles({
    migrationsFolder: fileURLToPath(new URL('../../drizzle/', import.meta.url)),
  }).map(({ hash, folderMillis }) => ({ hash, created_at: String(folderMillis) }));
  const db = {
    execute: async (query: SQL) => dialect.sqlToQuery(query).sql.includes('__drizzle_migrations')
      ? appliedMigrations
      : [],
    select: (projection?: Record<string, unknown>) => ({
      from: (baseTable: Table) => {
        let joinTable: Table | null = null;
        let joinOn: SQL | undefined;
        let whereExpr: SQL | undefined;
        let shouldOrderDesc = false;
        let limitVal: number | undefined;

        const runSelect = (): RowRecord[] => {
          const baseName = getTableName(baseTable);
          const baseRows = getRows(baseTable);
          const pairs: Array<Map<string, RowRecord>> = [];

          if (joinTable) {
            const joinName = getTableName(joinTable);
            for (const bRow of baseRows) {
              for (const jRow of getRows(joinTable)) {
                const map = new Map<string, RowRecord>([
                  [baseName, bRow],
                  [joinName, jRow],
                ]);
                if (matchesWhere(map, baseTable, joinOn, [joinTable])) {
                  pairs.push(map);
                }
              }
            }
          } else {
            for (const bRow of baseRows) {
              pairs.push(new Map<string, RowRecord>([[baseName, bRow]]));
            }
          }

          const extraTables = joinTable ? [joinTable] : [];
          let filtered = pairs.filter((map) => matchesWhere(map, baseTable, whereExpr, extraTables));

          if (shouldOrderDesc) {
            filtered = [...filtered].sort((a, b) => {
              const aDate = a.get(baseName)?.['createdAt'];
              const bDate = b.get(baseName)?.['createdAt'];
              const aMs = aDate instanceof Date ? aDate.getTime() : 0;
              const bMs = bDate instanceof Date ? bDate.getTime() : 0;
              return bMs - aMs;
            });
          }

          if (
            projection &&
            Object.keys(projection).length === 1 &&
            'total' in projection &&
            !(projection['total'] as { name?: string })?.name
          ) {
            return [{ total: filtered.length }];
          }

          const projected = filtered.map((map) => projectRow(projection, map, baseTable));
          return typeof limitVal === 'number' ? projected.slice(0, limitVal) : projected;
        };

        const queryBuilder = {
          innerJoin: (targetTable: Table, onExpr: SQL) => {
            joinTable = targetTable;
            joinOn = onExpr;
            return queryBuilder;
          },
          where: (expr: SQL) => {
            whereExpr = expr;
            return queryBuilder;
          },
          orderBy: () => {
            shouldOrderDesc = true;
            return queryBuilder;
          },
          limit: async (n: number) => {
            limitVal = n;
            return runSelect();
          },
          then: <TResult1 = RowRecord[], TResult2 = never>(
            onfulfilled?: ((value: RowRecord[]) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
          ) => Promise.resolve(runSelect()).then(onfulfilled, onrejected),
        };

        return queryBuilder;
      },
    }),
    insert: (table: Table) => ({
      values: (input: RowRecord | RowRecord[]) => {
        const items = Array.isArray(input) ? input : [input];
        let ignoreConflicts = false;
        let insertedCache: RowRecord[] | null = null;

        const commitInsert = (): RowRecord[] => {
          if (insertedCache) {
            return insertedCache;
          }
          const tableRows = getRows(table);
          const tableName = getTableName(table);
          const createdRows: RowRecord[] = [];

          for (const item of items) {
            if (ignoreConflicts) {
              if (tableName === 'auth_consumed_tokens' &&
                  tableRows.some((r) => r['digest'] === item['digest'])) {
                continue;
              }
              if (
                tableName === 'users_groups' &&
                tableRows.some(
                  (r) => r['userId'] === item['userId'] && r['groupId'] === item['groupId'],
                )
              ) {
                continue;
              }
              if (
                tableName === 'company_user' &&
                tableRows.some(
                  (r) => r['userId'] === item['userId'] && r['companyId'] === item['companyId'],
                )
              ) {
                continue;
              }
            }
            const normalized = applyDefaults(table, item);
            tableRows.push(normalized);
            createdRows.push(normalized);
          }

          insertedCache = createdRows;
          return createdRows;
        };

        const insertBuilder = {
          onConflictDoNothing: () => {
            ignoreConflicts = true;
            return insertBuilder;
          },
          returning: async (projection?: Record<string, unknown>) => {
            const createdRows = commitInsert();
            if (!projection) {
              return createdRows.map((r) => ({ ...r }));
            }
            return createdRows.map((r) =>
              projectRow(projection, new Map([[getTableName(table), r]]), table),
            );
          },
          then: <TResult1 = RowRecord[], TResult2 = never>(
            onfulfilled?: ((value: RowRecord[]) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
          ) => Promise.resolve(commitInsert()).then(onfulfilled, onrejected),
        };

        return insertBuilder;
      },
    }),
    update: (table: Table) => ({
      set: (patch: RowRecord) => ({
        where: (whereExpr: SQL) => {
          let updatedCache: RowRecord[] | null = null;
          const commitUpdate = (): RowRecord[] => {
            if (updatedCache) {
              return updatedCache;
            }
            const tableName = getTableName(table);
            const tableRows = getRows(table);
            const updated: RowRecord[] = [];
            for (const row of tableRows) {
              if (matchesWhere(new Map([[tableName, row]]), table, whereExpr)) {
                Object.assign(row, patch);
                updated.push(row);
              }
            }
            updatedCache = updated;
            return updated;
          };

          return {
            returning: async () => commitUpdate().map((r) => ({ ...r })),
            then: <TResult1 = RowRecord[], TResult2 = never>(
              onfulfilled?: ((value: RowRecord[]) => TResult1 | PromiseLike<TResult1>) | null,
              onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
            ) => Promise.resolve(commitUpdate()).then(onfulfilled, onrejected),
          };
        },
      }),
    }),
    delete: (table: Table) => ({
      where: async (whereExpr: SQL) => {
        const tableName = getTableName(table);
        const rows = getRows(table);
        const kept = rows.filter(
          (row) => !matchesWhere(new Map([[tableName, row]]), table, whereExpr),
        );
        store.set(tableName, kept);
        return undefined;
      },
    }),
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
      const snapshot = new Map<string, RowRecord[]>(
        [...store.entries()].map(([k, v]) => [k, structuredClone(v)]),
      );
      const seqSnapshot = new Map(sequences);
      try {
        return await cb(db);
      } catch (err) {
        store.clear();
        for (const [k, v] of snapshot.entries()) {
          store.set(k, v);
        }
        sequences.clear();
        for (const [k, v] of seqSnapshot.entries()) {
          sequences.set(k, v);
        }
        throw err;
      }
    },
  };

  return { appliedMigrations, db: db as unknown as DrizzleDb, store };
}

function getCookieValue(
  cookies: Array<{ name: string; value: string; maxAge?: number; expires?: Date }>,
  name: string,
): string | undefined {
  return cookies.find((c) => c.name === name)?.value;
}

describe('Auth & Setup Fastify HTTP E2E (1.4 & 1.4b Runtime Verification)', () => {
  let app: NestFastifyApplication;
  let harness: ReturnType<typeof createInMemoryDrizzleHarness>;
  let tempStorageDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let idpPrivateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let idpPublicJwk: JWK;
  let oidcMfaMode: 'none' | 'mfa' = 'none';
  let oidcSubjectMode: 'normal' | 'rebinding_attack' = 'normal';

  const idpIssuer = 'https://idp.test.local';
  const idpClientId = 'kestrel-e2e-client';
  const issuedAuthCodes = new Map<string, { nonce: string; codeChallenge: string }>();

  beforeAll(async () => {
    originalEnv = { ...process.env };
    tempStorageDir = await mkdtemp(join(tmpdir(), 'kestrel-http-e2e-'));

    const pair = await generateKeyPair('RS256');
    idpPrivateKey = pair.privateKey;
    idpPublicJwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: 'idp-key-1',
      use: 'sig',
      alg: 'RS256',
    };

    const e2eEnv = validateEnv({
      NODE_ENV: 'test',
      APP_NAME: 'Kestrel-IT E2E',
      APP_URL: 'http://localhost:4200',
      API_PREFIX: 'api/v1',
      JWT_SECRET: 'e2e-jwt-secret-super-secure-32-chars!',
      APP_ENCRYPTION_KEY: 'b'.repeat(64),
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_ROOT: tempStorageDir,
      OIDC_ENABLED: 'true',
      OAUTH_PROTOCOL: 'oidc',
      OIDC_ISSUER_URL: idpIssuer,
      OIDC_CLIENT_ID: idpClientId,
      OIDC_CLIENT_SECRET: 'kestrel-e2e-secret',
      OIDC_REDIRECT_URI: 'http://localhost:4200/api/v1/auth/oidc/callback',
      OIDC_AUTO_PROVISION_USERS: 'true',
      OIDC_LINK_EXISTING_USERS: 'true',
      OIDC_SYNC_ON_LOGIN: 'true',
      OIDC_SYNC_GROUPS: 'true',
      BETTER_AUTH_ENABLED: 'true',
      BETTER_AUTH_MODE: 'federated',
      BETTER_AUTH_SECRET: 'e2e-better-auth-secret-32-chars!!',
      BETTER_AUTH_URL: 'https://better-auth.test.local',
      BETTER_AUTH_PASSKEY_ENABLED: 'true',
      BETTER_AUTH_PROVIDERS: 'keycloak,passkey',
      BOOTSTRAP_ADMIN_USERNAME: '',
      BOOTSTRAP_ADMIN_EMAIL: '',
      BOOTSTRAP_ADMIN_PASSWORD: '',
    });

    Object.assign(process.env, {
      NODE_ENV: 'test',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);

        if (url === `${idpIssuer}/.well-known/openid-configuration`) {
          return new Response(
            JSON.stringify({
              issuer: idpIssuer,
              authorization_endpoint: `${idpIssuer}/authorize`,
              token_endpoint: `${idpIssuer}/token`,
              userinfo_endpoint: `${idpIssuer}/userinfo`,
              jwks_uri: `${idpIssuer}/jwks.json`,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        if (url === `${idpIssuer}/jwks.json`) {
          return new Response(JSON.stringify({ keys: [idpPublicJwk] }), {
            status: 200,
            headers: { 'content-type': 'application/jwk-set+json' },
          });
        }

        if (url === `${idpIssuer}/token`) {
          const bodyText = String(init?.body ?? '');
          const params = new URLSearchParams(bodyText);
          const code = params.get('code') ?? '';
          const codeVerifier = params.get('code_verifier') ?? '';
          const entry = issuedAuthCodes.get(code);
          if (!entry) {
            return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
          }
          const expectedChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
          if (expectedChallenge !== entry.codeChallenge) {
            return new Response(JSON.stringify({ error: 'invalid_pkce' }), { status: 400 });
          }

          const sub = oidcSubjectMode === 'rebinding_attack' ? 'attacker-sub-999' : 'kc-e2e-sub-1';
          const amr = oidcMfaMode === 'mfa' ? ['pwd', 'mfa'] : ['pwd'];

          const idToken = await new SignJWT({
            nonce: entry.nonce,
            preferred_username: 'elena.federated',
            email: 'elena.federated@example.com',
            email_verified: true,
            given_name: 'Elena',
            family_name: 'Federated',
            name: 'Elena Federated',
            groups: ['helpdesk'],
            amr,
          })
            .setProtectedHeader({ alg: 'RS256', kid: 'idp-key-1' })
            .setIssuer(idpIssuer)
            .setSubject(sub)
            .setAudience(idpClientId)
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(idpPrivateKey);

          return new Response(
            JSON.stringify({
              id_token: idToken,
              access_token: 'idp-access-token',
              token_type: 'Bearer',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        if (url === `${idpIssuer}/userinfo`) {
          return new Response(
            JSON.stringify({
              sub: oidcSubjectMode === 'rebinding_attack' ? 'attacker-sub-999' : 'kc-e2e-sub-1',
              preferred_username: 'elena.federated',
              email: 'elena.federated@example.com',
              email_verified: true,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        if (url === 'https://better-auth.test.local/api/auth/get-session') {
          const authHeader = (init?.headers as Record<string, string> | undefined)?.authorization;
          if (authHeader !== 'Bearer valid-ba-session-token') {
            return new Response(null, { status: 401 });
          }
          return new Response(
            JSON.stringify({
              user: {
                id: 'ba-federated-user-2',
                email: 'ba.user@example.com',
                emailVerified: true,
                username: 'ba.user',
                firstName: 'Better',
                lastName: 'AuthUser',
                groups: ['helpdesk'],
              },
              session: {
                userId: 'ba-federated-user-2',
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                amr: ['pwd', 'otp'],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        return new Response(null, { status: 404 });
      }),
    );

    harness = createInMemoryDrizzleHarness();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ConfigService)
      .useValue({ get: (key: keyof typeof e2eEnv) => e2eEnv[key] })
      .overrideProvider(POSTGRES_CLIENT)
      .useValue({ end: async () => undefined })
      .overrideProvider(DRIZZLE_DB)
      .useValue(harness.db)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie);
    await app.register(fastifyMultipart);
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    // Seed a group for OIDC group synchronization tests
    harness.store.set('groups', [
      {
        id: 1,
        name: 'helpdesk',
        permissions: { 'assets.view': 1, 'self.two_factor': 1, 'self.api': 1 },
        notes: 'Helpdesk group',
        scimExternalid: null,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (app) {
      await app.close();
    }
    if (tempStorageDir) {
      await rm(tempStorageDir, { recursive: true, force: true });
    }
    process.env = originalEnv;
  });

  it('requires the migration journal to match the release before reporting readiness', async () => {
    const probe = () => app.inject({ method: 'GET', url: '/ready' });
    expect((await probe()).statusCode).toBe(200);

    const latestMigration = harness.appliedMigrations.pop()!;
    const earlierCount = harness.appliedMigrations.length;
    try {
      expect((await probe()).statusCode).toBe(503);
      harness.appliedMigrations.push({ ...latestMigration, hash: 'different migration' });
      expect((await probe()).statusCode).toBe(503);
    } finally {
      harness.appliedMigrations.length = earlierCount;
      harness.appliedMigrations.push(latestMigration);
    }
  });

  it('completes first-run setup over HTTP, sets session cookies, and locks setup with 403', async () => {
    const preStatus = await app.inject({ method: 'GET', url: '/api/v1/setup/status' });
    expect(preStatus.statusCode).toBe(200);
    expect(preStatus.json()).toMatchObject({
      setupCompleted: false,
      checks: {
        database: true,
        storageWritable: true,
        oidcConfigured: true,
      },
    });

    const completeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/complete',
      payload: {
        siteName: 'Kestrel E2E Corp',
        locale: 'en-US',
        defaultCurrency: 'EUR',
        fullMultipleCompaniesSupport: false,
        autoIncrementAssets: true,
        autoIncrementPrefix: 'KST-',
        zerofillCount: 5,
        firstName: 'Ada',
        lastName: 'Lovelace',
        username: 'ada.admin',
        email: 'ada@example.com',
        password: 'SuperSecurePassword123!',
      },
    });

    expect(completeRes.statusCode).toBe(201);
    const completeBody = completeRes.json<{ status: string; payload: LoginResponse }>();
    expect(completeBody.status).toBe('success');
    expect(completeBody.payload.status).toBe('authenticated');

    const accessCookie = getCookieValue(completeRes.cookies, 'kestrel_access_token');
    const refreshCookie = getCookieValue(completeRes.cookies, 'kestrel_refresh_token');
    expect(accessCookie).toBeTruthy();
    expect(refreshCookie).toBeTruthy();

    const postStatus = await app.inject({ method: 'GET', url: '/api/v1/setup/status' });
    expect(postStatus.statusCode).toBe(200);
    expect(postStatus.json()).toMatchObject({ setupCompleted: true, checks: { oidcConfigured: true } });
    const providers = await app.inject({ method: 'GET', url: '/api/v1/auth/providers' });
    expect(providers.json()).toMatchObject({ sso: { enabled: true } });

    // Subsequent setup attempt must be locked with 403 Forbidden
    const duplicateRes = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/complete',
      payload: {
        siteName: 'Second Attempt',
        firstName: 'Eve',
        lastName: 'Attacker',
        username: 'eve',
        email: 'eve@example.com',
        password: 'SuperSecurePassword123!',
      },
    });
    expect(duplicateRes.statusCode).toBe(403);
  });

  it('enforces local 2FA enrollment + verification, session cookies, refresh rotation, and logout JTI persistence', async () => {
    // Enable mandatory 2FA globally
    const settingsRows = harness.store.get('settings')!;
    settingsRows[0]!['twoFactorEnabled'] = TWO_FACTOR_POLICY.REQUIRED;

    // 1. Local login must demand 2FA challenge without setting session cookies
    const challengeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        username: 'ada.admin',
        password: 'SuperSecurePassword123!',
      },
    });
    expect(challengeRes.statusCode).toBe(200);
    const challengeBody = challengeRes.json<LoginResponse>();
    expect(challengeBody.status).toBe('2fa_required');
    expect(getCookieValue(challengeRes.cookies, 'kestrel_access_token')).toBeUndefined();

    if (challengeBody.status !== '2fa_required') {
      throw new Error('Expected 2fa_required');
    }
    expect(challengeBody.requiresEnrollment).toBe(true);

    // 2. Enroll TOTP
    const enrollRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/2fa/enroll',
      payload: { challengeToken: challengeBody.challengeToken },
    });
    expect(enrollRes.statusCode).toBe(200);
    const { secret, otpauthUri } = enrollRes.json<{ secret: string; otpauthUri: string }>();
    expect(otpauthUri).toContain('otpauth://totp/');

    // 3. Verify TOTP code and obtain session cookies
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/2fa/verify',
      payload: {
        challengeToken: challengeBody.challengeToken,
        code: generateTotpCode(secret),
      },
    });
    expect(verifyRes.statusCode).toBe(200);
    const verifiedBody = verifyRes.json<LoginResponse>();
    expect(verifiedBody.status).toBe('authenticated');

    const initialAccessCookie = getCookieValue(verifyRes.cookies, 'kestrel_access_token')!;
    const initialRefreshCookie = getCookieValue(verifyRes.cookies, 'kestrel_refresh_token')!;
    expect(initialAccessCookie).toBeTruthy();
    expect(initialRefreshCookie).toBeTruthy();

    // 4. Access authenticated user profile via HttpOnly cookie on both /users/me and /auth/me
    const meUsersRes = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { cookie: `kestrel_access_token=${initialAccessCookie}` },
    });
    expect(meUsersRes.statusCode).toBe(200);
    expect(meUsersRes.json<AuthenticatedUserContext>()).toMatchObject({
      username: 'ada.admin',
      isSuperUser: true,
      twoFactorEnrolled: true,
      twoFactorVerified: true,
      authMethod: 'jwt',
    });

    const meAuthRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: `kestrel_access_token=${initialAccessCookie}` },
    });
    expect(meAuthRes.statusCode).toBe(200);
    expect(meAuthRes.json<AuthenticatedUserContext>().username).toBe('ada.admin');

    // 5. Refresh token rotation
    const refreshRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `kestrel_refresh_token=${initialRefreshCookie}` },
      payload: {},
    });
    expect(refreshRes.statusCode).toBe(200);
    const rotatedRefreshCookie = getCookieValue(refreshRes.cookies, 'kestrel_refresh_token')!;
    expect(rotatedRefreshCookie).toBeTruthy();
    expect(rotatedRefreshCookie).not.toBe(initialRefreshCookie);

    // Replaying already-rotated refresh token must fail with 401
    const replayRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: initialRefreshCookie },
    });
    expect(replayRes.statusCode).toBe(401);

    // 6. The refresh cookie is sufficient for logout after the access cookie expires.
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/logout',
      headers: {
        cookie: `kestrel_refresh_token=${rotatedRefreshCookie}`,
      },
      payload: {},
    });
    expect(logoutRes.statusCode).toBe(200);
    const clearedAccess = logoutRes.cookies.find((c) => c.name === 'kestrel_access_token');
    expect(clearedAccess?.value).toBe('');

    // Refreshing with the logged-out refresh token must return 401 over HTTP
    const postLogoutRefresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: rotatedRefreshCookie },
    });
    expect(postLogoutRefresh.statusCode).toBe(401);

    // A separate API instance consults the same database revocation state.
    const freshAuthService = new AuthService(
      harness.db,
      app.get(ConfigService),
      app.get(CryptoService),
      app.get(JwtService),
      app.get(OidcUserProvisioningService),
    );
    await expect(freshAuthService.refreshTokens(rotatedRefreshCookie)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('executes OIDC PKCE S256 login + RS256 JWKS callback, enforces MFA policy, and blocks subject rebinding', async () => {
    const performOidcFlow = async (
      accept = 'application/json',
      redirect?: string,
      protocol: 'oidc' | 'oauth' = 'oidc',
    ) => {
      const loginUrl =
        redirect !== undefined
          ? `/api/v1/auth/${protocol}/login?redirect=${encodeURIComponent(redirect)}`
          : `/api/v1/auth/${protocol}/login`;
      const loginRes = await app.inject({ method: 'GET', url: loginUrl });
      expect(loginRes.statusCode).toBe(302);
      const stateCookie = getCookieValue(loginRes.cookies, 'kestrel_oidc_state')!;
      expect(stateCookie).toBeTruthy();
      const stateCookieHeader = [loginRes.headers['set-cookie']]
        .flat()
        .find((header) => header?.startsWith('kestrel_oidc_state='));
      expect(stateCookieHeader).toBeDefined();
      expect(Buffer.byteLength(stateCookieHeader!)).toBeLessThan(4096);

      const location = new URL(String(loginRes.headers['location']));
      const state = location.searchParams.get('state')!;
      const nonce = location.searchParams.get('nonce')!;
      const codeChallenge = location.searchParams.get('code_challenge')!;
      expect(location.searchParams.get('code_challenge_method')).toBe('S256');

      const code = `auth-code-${randomUUID()}`;
      issuedAuthCodes.set(code, { nonce, codeChallenge });

      return app.inject({
        method: 'GET',
        url: `/api/v1/auth/${protocol}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
        headers: { cookie: `kestrel_oidc_state=${stateCookie}`, accept },
      });
    };

    // Under global 2FA REQUIRED and amr=['pwd'] (no MFA), federated login provisions JIT but requires 2FA challenge
    oidcMfaMode = 'none';
    oidcSubjectMode = 'normal';
    const mfaRequiredCallback = await performOidcFlow();
    expect(mfaRequiredCallback.statusCode).toBe(200);
    const mfaRequiredBody = mfaRequiredCallback.json<LoginResponse>();
    expect(mfaRequiredBody.status).toBe('2fa_required');
    expect(getCookieValue(mfaRequiredCallback.cookies, 'kestrel_access_token')).toBeUndefined();

    const browserChallenge = await performOidcFlow('text/html');
    expect(browserChallenge.statusCode).toBe(303);
    expect(browserChallenge.headers['location']).toBe('/login?sso=challenge');
    const redirectedChallenge = await performOidcFlow(
      'text/html',
      '/hardware/audit/due-or-overdue',
      'oauth',
    );
    expect(redirectedChallenge.statusCode).toBe(303);
    expect(redirectedChallenge.headers['location']).toBe(
      '/login?sso=challenge&redirect=%2Fhardware%2Faudit%2Fdue-or-overdue',
    );
    const longReportPath = '/reports/custom?columns=' + 'inventory_column,'.repeat(180);
    const oversizedChallenge = await performOidcFlow('text/html', longReportPath, 'oauth');
    expect(oversizedChallenge.statusCode).toBe(303);
    expect(oversizedChallenge.headers['location']).toBe('/login?sso=challenge');
    const challengeCookie = browserChallenge.cookies.find((c) => c.name === 'kestrel_sso_challenge');
    expect(challengeCookie).toMatchObject({ httpOnly: true });
    const handoff = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sso/challenge',
      headers: { cookie: `kestrel_sso_challenge=${challengeCookie?.value}` },
    });
    expect(handoff.statusCode).toBe(200);
    expect(handoff.json<LoginResponse>().status).toBe('2fa_required');

    // With IdP MFA claim amr=['pwd', 'mfa'], federated login issues authenticated session directly
    oidcMfaMode = 'mfa';
    const authenticatedCallback = await performOidcFlow();
    expect(authenticatedCallback.statusCode).toBe(200);
    const authBody = authenticatedCallback.json<LoginResponse>();
    expect(authBody.status).toBe('authenticated');
    if (authBody.status === 'authenticated') {
      expect(authBody.user.username).toBe('elena.federated');
      expect(authBody.user.groupIds).toEqual([1]);
      expect(authBody.user.effectivePermissions['assets.view']).toBe(true);
    }

    const browserSuccess = await performOidcFlow('text/html');
    expect(browserSuccess.statusCode).toBe(303);
    expect(browserSuccess.headers['location']).toBe('/dashboard');
    expect(getCookieValue(browserSuccess.cookies, 'kestrel_access_token')).toBeTruthy();

    const redirectedSuccess = await performOidcFlow('text/html', '/hardware/audit/due-or-overdue');
    expect(redirectedSuccess.statusCode).toBe(303);
    expect(redirectedSuccess.headers['location']).toBe('/hardware/audit/due-or-overdue');

    const longestSupportedPath = '/reports/custom?columns='.padEnd(2048, 'x');
    const boundedSuccess = await performOidcFlow('text/html', longestSupportedPath);
    expect(boundedSuccess.statusCode).toBe(303);
    expect(boundedSuccess.headers['location']).toBe(longestSupportedPath);

    const encodedReportPath = '/reports/custom?columns=' + 'è'.repeat(700);
    const oversizedSuccess = await performOidcFlow('text/html', encodedReportPath);
    expect(oversizedSuccess.statusCode).toBe(303);
    expect(oversizedSuccess.headers['location']).toBe('/dashboard');
    expect(getCookieValue(oversizedSuccess.cookies, 'kestrel_access_token')).toBeTruthy();

    const unsafeSuccess = await performOidcFlow('text/html', '//evil.example/phish', 'oauth');
    expect(unsafeSuccess.statusCode).toBe(303);
    expect(unsafeSuccess.headers['location']).toBe('/dashboard');

    // Subject rebinding attempt with different sub on same issuer & username must fail with 401
    oidcSubjectMode = 'rebinding_attack';
    const rebindingRes = await performOidcFlow();
    expect(rebindingRes.statusCode).toBe(401);
  });

  it('verifies Better Auth HMAC + federated session bridge and Personal Access Token lifecycle over HTTP', async () => {
    const baService = app.get(BetterAuthService);
    const baPayload = {
      id: 'ba-signed-1',
      email: 'passkey.ops@example.com',
      emailVerified: true,
      username: 'passkey.ops',
      firstName: 'Passkey',
      lastName: 'Operator',
      groups: ['helpdesk'],
      twoFactorVerified: true,
    };
    const assertion = {
      providerId: 'passkey',
      user: baPayload,
      issuedAt: Math.floor(Date.now() / 1000),
      nonce: randomUUID(),
    };
    const signature = baService.signBetterAuthBridgePayload(assertion);

    // 1. Signed Better Auth passkey payload satisfies MFA policy and returns authenticated session
    const signedRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/better-auth/exchange',
      payload: {
        ...assertion,
        signature,
      },
    });
    expect(signedRes.statusCode).toBe(200);
    const signedBody = signedRes.json<LoginResponse>();
    expect(signedBody.status).toBe('authenticated');

    // 2. Federated Better Auth session lookup via /api/auth/get-session (amr includes 'otp')
    const federatedRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/better-auth/exchange',
      payload: {
        providerId: 'keycloak',
        sessionToken: 'valid-ba-session-token',
      },
    });
    expect(federatedRes.statusCode).toBe(200);
    const federatedBody = federatedRes.json<LoginResponse>();
    expect(federatedBody.status).toBe('authenticated');
    if (federatedBody.status !== 'authenticated') {
      throw new Error('Expected authenticated Better Auth session');
    }

    // 3. Create, list, use, and revoke PAT via HTTP
    const accessToken = federatedBody.accessToken;
    const createPatRes = await app.inject({
      method: 'POST',
      url: '/api/v1/account/personal-access-tokens',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'E2E Automation Token' },
    });
    expect(createPatRes.statusCode).toBe(201);
    const patCreated = createPatRes.json<{
      status: string;
      payload: { id: string; token: string; name: string };
    }>();
    expect(patCreated.payload.token.startsWith('kst_')).toBe(true);

    const listPatRes = await app.inject({
      method: 'GET',
      url: '/api/v1/account/personal-access-tokens',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listPatRes.statusCode).toBe(200);
    expect(listPatRes.json<Array<{ id: string }>>().map((t) => t.id)).toContain(
      patCreated.payload.id,
    );

    // Authenticate API request using the created PAT
    const patMeRes = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${patCreated.payload.token}` },
    });
    expect(patMeRes.statusCode).toBe(200);
    expect(patMeRes.json<AuthenticatedUserContext>()).toMatchObject({
      username: 'ba.user',
      authMethod: 'pat',
    });

    // Revoke PAT -> 204, then reusing revoked PAT must return 401
    const revokeRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/account/personal-access-tokens/${patCreated.payload.id}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(revokeRes.statusCode).toBe(204);

    const revokedPatMeRes = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${patCreated.payload.token}` },
    });
    expect(revokedPatMeRes.statusCode).toBe(401);
  });
});

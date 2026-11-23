import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JwtService } from '../common/crypto/jwt.util.js';
import { STORAGE_PROVIDER, type StorageProvider } from '../common/storage/storage.interface.js';
import type { DrizzleDb } from '../db/database.tokens.js';
import * as tables from '../db/schema/index.js';
import { InventoryMailService } from '../modules/inventory/inventory-mail.service.js';

const clusterUrl = process.env.INVENTORY_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../drizzle/', import.meta.url));
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type Token = 'root' | 'west' | 'east' | 'admin' | 'westPat';

describe.skipIf(!clusterUrl)('Phase 2 through Fastify and PostgreSQL 16', () => {
  const databaseName = `kestrel_inventory_test_${randomBytes(6).toString('hex')}`;
  const upgradeName = databaseName + '_upgrade';
  let cluster: ReturnType<typeof postgres>;
  let connection: ReturnType<typeof postgres>;
  let db: DrizzleDb;
  let app: NestFastifyApplication;
  let storageRoot: string;
  let smtp: Server;
  let root: number;
  let west: number;
  let east: number;
  let parentCompany: number;
  let westCompany: number;
  let eastCompany: number;
  let westLocation: number;
  let eastLocation: number;
  let status: number;
  let model: number;
  let fieldset: number;
  let encryptedKey: string;
  let visibleKey: string;
  const tokens = new Map<Token, string>();

  function databaseUrl(name: string) {
    const url = new URL(clusterUrl!);
    url.pathname = '/' + name;
    return url.href;
  }

  beforeAll(async () => {
    cluster = postgres(clusterUrl!, { max: 1 });
    await cluster`create database ${cluster(databaseName)}`;
    connection = postgres(databaseUrl(databaseName), { max: 8 });
    db = drizzle(connection, { schema: tables });
    await migrate(db, { migrationsFolder: migrations });
    storageRoot = await mkdtemp(join(tmpdir(), 'kestrel-inventory-storage-'));
    vi.stubEnv('DATABASE_URL', databaseUrl(databaseName));
    vi.stubEnv('STORAGE_DRIVER', 'local');
    vi.stubEnv('STORAGE_LOCAL_ROOT', storageRoot);
    vi.stubEnv('APP_ENCRYPTION_KEY', 'ab'.repeat(32));
    smtp = createServer((socket) => socket.end('421 Temporary test failure\r\n'));
    await new Promise<void>((resolve, reject) => {
      smtp.once('error', reject);
      smtp.listen(0, '127.0.0.1', resolve);
    });
    const address = smtp.address();
    if (!address || typeof address === 'string')
      throw new Error('Test SMTP socket is not listening');
    vi.stubEnv('SMTP_HOST', '127.0.0.1');
    vi.stubEnv('SMTP_PORT', String(address.port));
    const { AppModule } = await import('../app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.register(fastifyCookie);
    app.setGlobalPrefix('api/v1');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const userRows = await db
      .insert(tables.users)
      .values([
        {
          username: 'root',
          email: 'root@example.test',
          activated: true,
          permissions: { superuser: 1 },
        },
        {
          username: 'west',
          email: 'west@example.test',
          activated: true,
          permissions: {
            'assets.view': 1,
            'assets.create': 1,
            'assets.edit': 1,
            'assets.delete': 1,
            'assets.view.requestable': 1,
            'users.view': 1,
            'users.edit': 1,
            'locations.view': 1,
            'self.api': 1,
          },
        },
        {
          username: 'east',
          email: 'east@example.test',
          activated: true,
          permissions: {
            'assets.view': 1,
            'assets.view.requestable': 1,
          },
        },
        { username: 'admin', activated: true, permissions: { admin: 1, 'assets.checkout': -1 } },
      ])
      .returning({ id: tables.users.id });
    [root, west, east] = userRows.slice(0, 3).map(({ id }) => id) as [number, number, number];
    const jwt = app.get(JwtService);
    for (const [index, username] of (['root', 'west', 'east', 'admin'] as const).entries()) {
      tokens.set(
        username,
        await jwt.signAccessToken({
          userId: userRows[index]!.id,
          username,
          twoFactorVerified: true,
        }),
      );
    }
    const [parent] = await db.insert(tables.companies).values({ name: 'Region' }).returning();
    parentCompany = parent!.id;
    const companies = await db
      .insert(tables.companies)
      .values([{ name: 'West division', parentId: parentCompany }, { name: 'East division' }])
      .returning();
    westCompany = companies[0]!.id;
    eastCompany = companies[1]!.id;
    await db.insert(tables.companyUser).values([
      { userId: west, companyId: parentCompany },
      { userId: east, companyId: eastCompany },
      { userId: userRows[3]!.id, companyId: westCompany },
    ]);
    const locations = await db
      .insert(tables.locations)
      .values([
        { name: 'West office', companyId: westCompany },
        { name: 'East office', companyId: eastCompany },
      ])
      .returning();
    westLocation = locations[0]!.id;
    eastLocation = locations[1]!.id;
    await db
      .update(tables.users)
      .set({ locationId: westLocation })
      .where(eq(tables.users.id, west));
    const [label] = await db
      .insert(tables.statusLabels)
      .values({ name: 'Ready', deployable: true })
      .returning();
    status = label!.id;
    await db.insert(tables.settings).values({
      fullMultipleCompaniesSupport: true,
      scopeLocationsFmcs: true,
      nullCompanyIsFloater: false,
      autoIncrementAssets: true,
      autoIncrementPrefix: 'TEST-',
      zerofillCount: 4,
      nextAutoTagBase: 1,
      requireAcceptSignature: true,
      defaultEulaText: 'Original inventory agreement',
      alertEmail: 'alerts@example.test',
    });

    const category = await ok('POST', '/categories', 'root', {
      name: 'Hardware',
      category_type: 'asset',
      require_acceptance: true,
      use_default_eula: true,
      checkin_email: true,
      alert_on_response: true,
    });
    const set = await ok('POST', '/fieldsets', 'root', { name: 'Inventory attributes' });
    fieldset = set.payload.id;
    const encrypted = await ok('POST', '/fields', 'root', {
      name: 'Confidential ID',
      element: 'text',
      format: 'ANY',
      field_encrypted: true,
      is_unique: true,
      show_in_requestable_list: true,
      show_in_email: true,
    });
    encryptedKey = encrypted.payload.db_column;
    const visible = await ok('POST', '/fields', 'root', {
      name: 'Color',
      element: 'text',
      format: 'ALPHA',
      display_checkin: true,
      show_in_requestable_list: true,
    });
    visibleKey = visible.payload.db_column;
    await ok('POST', `/fieldsets/${fieldset}/fields`, 'root', {
      field_id: encrypted.payload.id,
      required: true,
    });
    await ok('POST', `/fieldsets/${fieldset}/fields`, 'root', { field_id: visible.payload.id });
    await ok('POST', `/fields/fieldsets/${fieldset}/order`, 'root', {
      field_ids: [visible.payload.id, encrypted.payload.id],
    });
    const modelResponse = await ok('POST', '/models', 'root', {
      name: 'Notebook model',
      category_id: category.payload.id,
      fieldset_id: fieldset,
      require_serial: true,
      requestable: true,
    });
    model = modelResponse.payload.id;
    const pat = await ok('POST', '/account/personal-access-tokens', 'west', {
      name: 'Inventory integration test',
    });
    tokens.set('westPat', pat.payload?.token ?? pat.token);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    if (smtp) await new Promise<void>((resolve) => smtp.close(() => resolve()));
    await connection?.end();
    if (cluster) {
      await cluster`drop database if exists ${cluster(databaseName)} with (force)`;
      await cluster`drop database if exists ${cluster(upgradeName)} with (force)`;
      await cluster.end();
    }
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function http(method: Method, path: string, actor: Token, payload?: object) {
    const token = tokens.get(actor);
    if (!token) throw new Error(`No test token for ${actor}`);
    return app.inject({
      method,
      url: '/api/v1' + path,
      headers: { authorization: 'Bearer ' + token },
      payload,
    });
  }

  async function ok(method: Method, path: string, actor: Token, payload?: object) {
    const result = await http(method, path, actor, payload);
    expect(result.statusCode, `${method} ${path} ${result.body}`).toBe(
      method === 'POST' ? 201 : 200,
    );
    return result.json();
  }

  const body = (serial: string, company = westCompany, fields: Record<string, unknown> = {}) => ({
    name: 'Test notebook',
    model_id: model,
    status_id: status,
    company_id: company,
    serial,
    requestable: true,
    rtd_location_id: company === eastCompany ? eastLocation : westLocation,
    custom_fields: { [encryptedKey]: 'key-' + serial, [visibleKey]: 'Blue', ...fields },
  });

  async function create(serial: string, company = westCompany) {
    return (await ok('POST', '/hardware', 'root', body(serial, company))).payload;
  }

  function signature() {
    const image = new PNG({ width: 16, height: 16 });
    image.data[3] = 255;
    return 'data:image/png;base64,' + PNG.sync.write(image).toString('base64');
  }

  it('enforces scoped directory and hardware reads for JWT and PAT callers', async () => {
    const westAsset = await create('West');
    const eastAsset = await create('East', eastCompany);
    for (const actor of ['west', 'westPat', 'admin'] as const) {
      const result = await ok('GET', '/hardware', actor);
      expect(result.rows.map((row: { id: number }) => row.id)).toEqual([westAsset.id]);
      expect(result.total).toBe(1);
      expect((await http('GET', `/hardware/${eastAsset.id}`, actor)).statusCode).toBe(404);
    }
    expect(
      (await ok('GET', '/users/selectlist', 'west')).results.map((row: { id: number }) => row.id),
    ).toContain(west);
    expect(
      (await ok('GET', '/users/selectlist', 'west')).results.map((row: { id: number }) => row.id),
    ).not.toContain(east);
    expect(
      (await http('PATCH', `/users/${west}`, 'west', { permissions: { superuser: 1 } })).statusCode,
    ).toBe(403);
    expect((await http('POST', '/hardware', 'west', body('Cross', eastCompany))).statusCode).toBe(
      422,
    );
    expect(
      (
        await http('POST', `/hardware/${westAsset.id}/checkout`, 'admin', {
          target_type: 'user',
          target_id: west,
        })
      ).statusCode,
    ).toBe(403);
    const parent = await ok('POST', '/locations', 'root', {
      name: 'Parent',
      company_id: westCompany,
    });
    await ok('POST', '/locations', 'root', {
      name: 'Child',
      parent_id: parent.payload.id,
      company_id: westCompany,
    });
    expect((await ok('GET', '/locations/selectlist?search=Child', 'west')).results[0].text).toBe(
      'Parent › Child',
    );
  });

  it('allocates tags concurrently and preserves encrypted uniqueness and read masking', async () => {
    const results = await Promise.all([create('Alpha'), create('Beta')]);
    expect(new Set(results.map((row) => row.asset_tag)).size).toBe(2);
    const duplicate = await Promise.all(
      ['DuplicateOne', 'DuplicateTwo'].map((name) =>
        http('POST', '/hardware', 'root', body(name, westCompany, { [encryptedKey]: 'same' })),
      ),
    );
    expect(duplicate.map((response) => response.statusCode).sort()).toEqual([201, 422]);
    const [stored] = await db
      .select()
      .from(tables.assets)
      .where(eq(tables.assets.id, results[0].id));
    expect(stored!.customFields[encryptedKey]).toMatch(/^enc:v1:/);
    const masked = await ok('GET', `/hardware/${results[0].id}`, 'west');
    expect(masked.custom_fields['Confidential ID'].value).toBe('ENCRYPTED');
    expect(
      (await ok('GET', `/hardware/${results[0].id}`, 'root')).custom_fields['Confidential ID']
        .value,
    ).toBe('key-Alpha');
    const matched = await ok(
      'GET',
      `/hardware?custom_field=${visibleKey}&custom_value=Blue`,
      'west',
    );
    expect(matched.rows.length).toBeGreaterThan(0);
    expect(
      (await http('GET', `/hardware?custom_field=${encryptedKey}&custom_value=key-Alpha`, 'root'))
        .statusCode,
    ).toBe(422);
    const saved = await ok('POST', '/saved-searches', 'west', {
      name: 'Blue assets',
      query: {
        custom_field: visibleKey,
        custom_value: 'Blue',
      },
    });
    expect((await http('GET', `/saved-searches/${saved.payload.id}`, 'east')).statusCode).toBe(404);
  });

  it('rejects restore conflicts and applies typed model defaults on creation', async () => {
    const asset = await create('Restore');
    await ok('POST', `/fieldsets/${fieldset}/fields/${model}`, 'root', {
      [encryptedKey]: 'Default code',
    });
    const createInput = body('Default');
    delete createInput.custom_fields[encryptedKey];
    const created = await ok('POST', '/hardware', 'root', createInput);
    expect(created.payload.custom_fields['Confidential ID'].value).toBe('Default code');
    await ok('DELETE', `/hardware/${asset.id}`, 'root');
    const duplicate = await http('POST', '/hardware', 'root', {
      ...body('Replacement'),
      asset_tag: asset.asset_tag,
    });
    expect(duplicate.statusCode).toBe(201);
    expect((await http('POST', `/hardware/${asset.id}/restore`, 'root')).statusCode).toBe(422);
  });

  it('rolls back a blocked license-seat checkout and prevents simultaneous assignments', async () => {
    const asset = await create('Seats');
    const [license] = await db
      .insert(tables.licenses)
      .values({
        name: 'Linked license',
        seats: 2,
        reassignable: false,
      })
      .returning();
    const [seat] = await db
      .insert(tables.licenseSeats)
      .values({
        licenseId: license!.id,
        assetId: asset.id,
        assignedTo: east,
      })
      .returning();
    const blocked = await http('POST', `/hardware/${asset.id}/checkout`, 'root', {
      target_type: 'user',
      target_id: west,
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    const untouched = await ok('GET', `/hardware/${asset.id}`, 'root');
    expect(untouched.checkout_counter).toBe(0);
    expect(untouched.assigned_to).toBeNull();
    await db
      .update(tables.licenseSeats)
      .set({ assignedTo: null })
      .where(eq(tables.licenseSeats.id, seat!.id));
    const results = await Promise.all(
      [west, east].map((target_id) =>
        http('POST', `/hardware/${asset.id}/checkout`, 'root', { target_type: 'user', target_id }),
      ),
    );
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const [row] = await db.select().from(tables.assets).where(eq(tables.assets.id, asset.id));
    const [changed] = await db
      .select()
      .from(tables.licenseSeats)
      .where(eq(tables.licenseSeats.id, seat!.id));
    expect(row?.checkoutCounter).toBe(1);
    expect(changed?.assignedTo).toBe(row?.assignedTo);
  });

  it('checks out to assets and locations without replacing the home location', async () => {
    const asset = await create('Nested');
    const receivingAsset = (
      await ok('POST', '/hardware', 'root', {
        ...body('Receiving'),
        location_id: eastLocation,
      })
    ).payload;
    await ok('POST', `/hardware/${asset.id}/checkout`, 'root', {
      target_type: 'asset',
      target_id: receivingAsset.id,
    });
    const nested = await ok('GET', `/hardware/${asset.id}`, 'root');
    expect(nested.location_id).toBe(eastLocation);
    expect(nested.rtd_location_id).toBe(westLocation);
    const circular = await http('POST', `/hardware/${receivingAsset.id}/checkout`, 'root', {
      target_type: 'asset',
      target_id: asset.id,
    });
    expect(circular.statusCode).toBe(422);
    await ok('POST', `/hardware/${asset.id}/checkin`, 'root', {});
    await ok('POST', `/hardware/${asset.id}/checkout`, 'root', {
      target_type: 'location',
      target_id: eastLocation,
    });
    await ok('POST', `/hardware/${asset.id}/checkin`, 'root', {});
    const returned = await ok('GET', `/hardware/${asset.id}`, 'root');
    expect(returned.location_id).toBe(westLocation);
    expect(returned.checkout_counter).toBe(2);
    expect(returned.checkin_counter).toBe(2);
  });

  it('snapshots EULAs, handles storage failure, and finalizes one authenticated response', async () => {
    const asset = await create('Signature');
    const checked = await ok('POST', `/hardware/${asset.id}/checkout`, 'root', {
      target_type: 'user',
      target_id: west,
    });
    const id: number = checked.payload.acceptance_id;
    await db.update(tables.settings).set({ defaultEulaText: 'Updated agreement' });
    const path = `/account/accept/${id}`;
    expect((await ok('GET', path, 'west')).eula).toBe('Original inventory agreement');
    expect((await http('GET', path, 'east')).statusCode).toBe(404);
    expect((await http('POST', path, 'west', { decision: 'accept' })).statusCode).toBe(422);
    const storage = app.get<StorageProvider>(STORAGE_PROVIDER);
    const put = storage.putObject.bind(storage);
    const failure = vi.spyOn(storage, 'putObject').mockImplementation(async (category, ...args) => {
      if (category === 'eulas') throw new Error('Storage unavailable');
      return put(category, ...args);
    });
    try {
      expect(
        (await http('POST', path, 'west', { decision: 'accept', signature: signature() }))
          .statusCode,
      ).toBe(500);
    } finally {
      failure.mockRestore();
    }
    expect((await ok('GET', path, 'west')).state).toBe('pending');
    const responses = await Promise.all(
      [1, 2].map(() =>
        http('POST', path, 'west', {
          decision: 'accept',
          signature: signature(),
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const pdf = await http('GET', path + '/eula', 'west');
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.body.slice(0, 4)).toBe('%PDF');
    expect((await http('GET', path + '/signature', 'east')).statusCode).toBe(404);
    const checkin = await ok('POST', '/hardware/checkinbytag', 'root', {
      asset_tag: asset.asset_tag,
    });
    expect(checkin.payload.checked_in).toBe(true);
    await ok('POST', `/hardware/bytag/${asset.asset_tag}/checkin`, 'root', {
      name: 'Handed back',
      custom_fields: { [visibleKey]: 'Green' },
    });
    const current = await ok('GET', `/hardware/${asset.id}`, 'west');
    expect(current.checkin_counter).toBe(1);
    expect(current.location_id).toBe(westLocation);
    const notices = await db
      .select()
      .from(tables.inventoryMailOutbox)
      .where(isNull(tables.inventoryMailOutbox.sentAt));
    expect(notices.some((row) => row.message.includes('key-Signature'))).toBe(false);
    expect(notices.some((row) => row.subject.includes('acceptance confirmed'))).toBe(true);
  });

  it('deduplicates requests and fulfills hardware and model requests atomically', async () => {
    const asset = await create('Request');
    const path = `/account/request/${asset.id}`;
    const results = await Promise.all([1, 2].map(() => http('POST', path, 'west', {})));
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const created = results.find((response) => response.statusCode === 201)!.json().payload;
    expect((await ok('GET', `/hardware/${asset.id}`, 'west')).requests_counter).toBe(1);
    expect((await http('POST', `/account/requests/${created.id}/cancel`, 'east')).statusCode).toBe(
      404,
    );
    const alert = await ok('GET', '/requests', 'root');
    expect(alert.rows.map((row: { id: number }) => row.id)).toContain(created.id);
    await ok('POST', `/requests/${created.id}/fulfill`, 'root', {});
    expect((await ok('GET', `/hardware/${asset.id}`, 'west')).requests_counter).toBe(0);
    const modelRequest = await ok('POST', `/account/request/models/${model}`, 'west', {});
    const selected = await create('ModelRequest');
    await ok('POST', `/requests/${modelRequest.payload.id}/fulfill`, 'root', {
      asset_id: selected.id,
    });
    expect((await ok('GET', `/hardware/${selected.id}`, 'west')).checkout_counter).toBe(1);
    const canceled = await create('CancelRequest');
    const ticket = await ok('POST', `/account/request/${canceled.id}`, 'west', {});
    const result = await ok('POST', `/account/requests/${ticket.payload.id}/cancel`, 'west');
    expect(result.payload.state).toBe('canceled');
    expect((await ok('GET', `/hardware/${canceled.id}`, 'west')).requests_counter).toBe(0);
  });

  it('schedules a retry on SMTP failure and upgrades populated Phase 1 migrations', async () => {
    await app.get(InventoryMailService).deliverOne();
    const [retry] = await db
      .select()
      .from(tables.inventoryMailOutbox)
      .where(
        and(
          sql`${tables.inventoryMailOutbox.attempts} > 0`,
          isNull(tables.inventoryMailOutbox.sentAt),
        ),
      )
      .limit(1);
    expect(retry?.availableAt.getTime()).toBeGreaterThan(Date.now());
    await cluster`create database ${cluster(upgradeName)}`;
    const upgraded = postgres(databaseUrl(upgradeName));
    const old = await mkdtemp(join(tmpdir(), 'kestrel-inventory-migrations-'));
    try {
      await mkdir(join(old, 'meta'));
      const journal = JSON.parse(await readFile(join(migrations, 'meta/_journal.json'), 'utf8'));
      journal.entries = journal.entries.slice(0, 2);
      await writeFile(join(old, 'meta/_journal.json'), JSON.stringify(journal));
      for (const item of journal.entries)
        await cp(join(migrations, item.tag + '.sql'), join(old, item.tag + '.sql'));
      await migrate(drizzle(upgraded), { migrationsFolder: old });
      await upgraded`insert into assets (asset_tag) values ('OLD-001')`;
      await migrate(drizzle(upgraded), { migrationsFolder: migrations });
      const [row] = await upgraded`select asset_tag, accepted from assets`;
      expect(row).toMatchObject({ asset_tag: 'OLD-001', accepted: null });
    } finally {
      await upgraded.end();
      await rm(old, { recursive: true, force: true });
    }
  }, 20_000);
});

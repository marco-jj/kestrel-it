import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
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
            'users.create': 1,
            'assets.checkout': 1,
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
            'assets.checkin': 1,
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

  it('reserves username and email changes for superusers in single and bulk directory edits', async () => {
    const { payload: account } = await ok('POST', '/users', 'root', {
      username: 'directory-subject',
      email: 'directory@example.test',
      activated: true,
      company_ids: [westCompany],
    });
    const path = `/users/${account.id}`;
    const changes = [
      { username: 'directory-renamed' },
      { email: 'directory-alias@example.test' },
      { email: null },
    ];
    for (const change of changes) {
      expect((await http('PATCH', path, 'west', change)).statusCode).toBe(403);
      expect(
        (
          await http('PATCH', '/users/bulk', 'west', {
            action: 'edit',
            ids: [account.id],
            changes: change,
          })
        ).statusCode,
      ).toBe(403);
    }
    await ok('PATCH', path, 'west', {
      username: account.username,
      email: account.email,
      first_name: 'Directory',
    });
    expect(await ok('GET', path, 'west')).toMatchObject({
      username: account.username,
      email: account.email,
      first_name: 'Directory',
    });
    await ok('PATCH', path, 'root', changes[0]);
    expect(await ok('GET', path, 'west')).toMatchObject(changes[0]!);
  });

  it('allows delegated creation of checkout recipients while keeping sign-in reserved', async () => {
    const payload = { username: 'equipment-recipient', company_ids: [westCompany] };
    expect((await http('POST', '/users', 'west', { ...payload, activated: true })).statusCode).toBe(
      403,
    );
    expect(
      (await http('POST', '/users', 'west', { ...payload, password: 'test-password-only' }))
        .statusCode,
    ).toBe(403);
    const { payload: recipient } = await ok('POST', '/users', 'west', payload);
    expect(recipient).toMatchObject({ activated: false, inventory_only: true });
    const { payload: disabled } = await ok('POST', '/users', 'root', {
      username: 'equipment-disabled',
      activated: false,
      company_ids: [westCompany],
    });
    const { results } = await ok(
      'GET',
      `/hardware/targets/user?companyId=${westCompany}&search=equipment`,
      'west',
    );
    expect(results).toContainEqual(expect.objectContaining({ id: recipient.id, disabled: false }));
    expect(results).toContainEqual(expect.objectContaining({ id: disabled.id, disabled: true }));

    const asset = await create('InventoryRecipient');
    const checkout = await ok('POST', `/hardware/${asset.id}/checkout`, 'west', {
      target_type: 'user',
      target_id: recipient.id,
      sign_in_place: true,
    });
    expect(checkout.payload.acceptance_id).toEqual(expect.any(Number));
    await ok('PATCH', `/users/${recipient.id}`, 'root', { activated: false });
    expect(await ok('GET', `/users/${recipient.id}`, 'west')).toMatchObject({
      activated: false,
      inventory_only: false,
    });
  });

  it('restricts company webhook settings on create, update, bulk edit, and reads', async () => {
    const webhook = {
      webhook_selected: 'slack',
      webhook_endpoint: 'https://hooks.example.test/company',
      webhook_channel: 'inventory',
      webhook_botname: 'Kestrel',
    };
    expect(
      (await http('POST', '/companies', 'admin', { name: 'Webhook company', ...webhook }))
        .statusCode,
    ).toBe(403);
    const companyPath = `/companies/${westCompany}`;
    expect((await http('PATCH', companyPath, 'admin', webhook)).statusCode).toBe(403);
    expect(
      (
        await http('PATCH', '/companies/bulk', 'admin', {
          action: 'edit',
          ids: [westCompany],
          changes: webhook,
        })
      ).statusCode,
    ).toBe(403);
    expect((await ok('PATCH', companyPath, 'root', webhook)).payload).toMatchObject(webhook);
    expect(await ok('GET', companyPath, 'root')).toMatchObject(webhook);
    expect(await ok('GET', companyPath, 'admin')).not.toHaveProperty('webhook_endpoint');
    const { payload: company } = await ok('POST', '/companies', 'root', {
      name: 'Webhook company',
      ...webhook,
    });
    expect(company).toMatchObject(webhook);
  });

  it('shows shared location breadcrumbs without exposing other companies or deleted ancestors', async () => {
    const [shared] = await db
      .insert(tables.locations)
      .values({ name: 'Shared building' })
      .returning();
    const child = await ok('POST', '/locations', 'root', {
      name: 'Visible room',
      company_id: westCompany,
      parent_id: shared!.id,
    });
    const path = `/locations/${child.payload.id}`;
    expect(child.payload.display_name).toBe('Shared building › Visible room');
    expect(await ok('GET', path, 'west')).toMatchObject({
      display_name: 'Shared building › Visible room',
    });
    expect((await http('GET', `/locations/${shared!.id}`, 'west')).statusCode).toBe(404);
    await db
      .update(tables.locations)
      .set({ companyId: eastCompany })
      .where(eq(tables.locations.id, shared!.id));
    expect(await ok('GET', path, 'west')).toMatchObject({ display_name: 'Visible room' });
    await db
      .update(tables.locations)
      .set({ companyId: null, deletedAt: new Date() })
      .where(eq(tables.locations.id, shared!.id));
    expect(await ok('GET', path, 'west')).toMatchObject({ display_name: 'Visible room' });

    const [room] = await db
      .insert(tables.locations)
      .values({ name: 'Room below', parentId: shared!.id })
      .returning();
    await db
      .update(tables.locations)
      .set({ parentId: child.payload.id })
      .where(eq(tables.locations.id, shared!.id));
    const changed = await ok('PATCH', path, 'root', { parent_id: room!.id });
    expect(changed.payload.display_name).toBe('Room below › Visible room');
    const restore = await http('POST', `/locations/${shared!.id}/restore`, 'root');
    expect(restore.statusCode).toBe(422);
  });

  it('filters selectlists by assignment company, including floater and shared locations', async () => {
    const [floater] = await db
      .insert(tables.locations)
      .values({ name: 'Floater office' })
      .returning();
    const westAsset = await create('PickerWest');
    const eastAsset = await create('PickerEast', eastCompany);
    await db.insert(tables.companyUser).values({ userId: west, companyId: eastCompany });
    await db.insert(tables.companyUser).values({ userId: west, companyId: westCompany });
    const company = '?companyId=' + westCompany;
    const ids = async (path: string, actor: Token = 'west') => {
      const { results } = await ok('GET', path, actor);
      return results.map(({ id }: { id: number }) => id);
    };
    try {
      expect(await ids('/hardware/targets/user' + company)).toContain(west);
      expect(await ids('/hardware/targets/user' + company)).not.toContain(east);
      expect(await ids('/hardware/targets/asset' + company)).toContain(westAsset.id);
      expect(await ids('/hardware/targets/asset' + company)).not.toContain(eastAsset.id);
      for (const path of ['/hardware/targets/location', '/locations/selectlist']) {
        const locations = await ids(path + company);
        expect(locations).toContain(westLocation);
        expect(locations).not.toContain(eastLocation);
        expect(locations).not.toContain(floater!.id);
      }
      expect(await ids('/hardware/targets/location?companyId=' + eastCompany, 'east')).toContain(
        eastLocation,
      );
      expect((await http('GET', '/hardware/targets/user' + company, 'east')).statusCode).toBe(403);

      await db.update(tables.settings).set({ nullCompanyIsFloater: true });
      expect(await ids('/hardware/targets/location' + company)).toContain(floater!.id);
      expect(await ids('/hardware/targets/location?companyId=0')).toEqual(
        expect.arrayContaining([westLocation, eastLocation, floater!.id]),
      );

      await db
        .update(tables.settings)
        .set({ scopeLocationsFmcs: false, nullCompanyIsFloater: false });
      expect(await ids('/hardware/targets/location' + company)).toContain(eastLocation);
      await ok('POST', `/hardware/${westAsset.id}/checkout`, 'west', {
        target_type: 'location',
        target_id: eastLocation,
      });
    } finally {
      await db
        .update(tables.settings)
        .set({ scopeLocationsFmcs: true, nullCompanyIsFloater: false });
      await db
        .delete(tables.companyUser)
        .where(
          and(
            eq(tables.companyUser.userId, west),
            inArray(tables.companyUser.companyId, [westCompany, eastCompany]),
          ),
        );
    }
  });

  it('validates the effective current and home locations when a scoped editor moves an asset', async () => {
    await db.insert(tables.companyUser).values({ userId: west, companyId: eastCompany });
    try {
      const asset = await create('CompanyMove');
      const path = `/hardware/${asset.id}`;
      for (const change of [
        { company_id: eastCompany },
        { company_id: eastCompany, location_id: eastLocation },
        { company_id: eastCompany, location_id: westLocation, rtd_location_id: eastLocation },
      ]) {
        expect((await http('PATCH', path, 'west', change)).statusCode).toBe(422);
      }
      expect(await ok('GET', path, 'west')).toMatchObject({
        company_id: westCompany,
        location_id: westLocation,
        rtd_location_id: westLocation,
      });
      await ok('PATCH', '/hardware/bulk', 'west', {
        action: 'edit',
        ids: [asset.id],
        changes: { company_id: eastCompany, rtd_location_id: eastLocation },
      });
      expect(await ok('GET', path, 'west')).toMatchObject({
        company_id: eastCompany,
        location_id: eastLocation,
        rtd_location_id: eastLocation,
      });
      await ok('POST', path + '/checkout', 'root', { target_type: 'user', target_id: east });
      await ok('POST', path + '/checkin', 'root');
      expect(await ok('GET', path, 'west')).toMatchObject({
        location_id: eastLocation,
        rtd_location_id: eastLocation,
        checkin_counter: 1,
      });
    } finally {
      await db
        .delete(tables.companyUser)
        .where(
          and(eq(tables.companyUser.userId, west), eq(tables.companyUser.companyId, eastCompany)),
        );
    }
  });

  it('changes model fieldsets atomically with confirmed removal, retained values, and new defaults', async () => {
    const categoryId = (await ok('GET', `/models/${model}`, 'root')).category_id;
    const color = (await ok('GET', '/fields?search=Color', 'root')).rows[0];
    const { payload: destination } = await ok('POST', '/fieldsets', 'root', {
      name: 'Destination fieldset',
    });
    const { payload: required } = await ok('POST', '/fields', 'root', {
      name: 'Destination code',
      element: 'text',
    });
    await ok('POST', `/fieldsets/${destination.id}/fields`, 'root', { field_id: color.id });
    await ok('POST', `/fieldsets/${destination.id}/fields`, 'root', {
      field_id: required.id,
      required: true,
    });
    const { payload: target } = await ok('POST', '/models', 'root', {
      name: 'Destination model',
      category_id: categoryId,
      fieldset_id: destination.id,
    });
    const asset = await create('ModelMove');
    const second = await create('ModelMoveTwo');
    const path = `/hardware/${asset.id}`;
    const update = { model_id: target.id, confirm_custom_field_removal: true };
    expect(
      (
        await http('PATCH', path, 'root', {
          model_id: target.id,
          custom_fields: { [required.db_column]: 'Supplied code' },
        })
      ).statusCode,
    ).toBe(422);
    expect((await http('PATCH', path, 'root', update)).statusCode).toBe(422);
    const [before] = await db.select().from(tables.assets).where(eq(tables.assets.id, asset.id));
    expect(before!.modelId).toBe(model);
    expect(before!.customFields[encryptedKey]).toMatch(/^enc:v1:/);
    await ok('POST', `/fieldsets/${destination.id}/fields/${target.id}`, 'root', {
      [required.db_column]: 'Default destination code',
    });
    await ok('PATCH', '/hardware/bulk', 'root', {
      action: 'edit',
      ids: [asset.id, second.id],
      changes: update,
    });
    for (const id of [asset.id, second.id] as number[]) {
      const [saved] = await db.select().from(tables.assets).where(eq(tables.assets.id, id));
      expect(saved!.modelId).toBe(target.id);
      expect(saved!.customFields).toEqual({
        [visibleKey]: 'Blue',
        [required.db_column]: 'Default destination code',
      });
    }
    await ok('PATCH', '/hardware/bulk', 'root', {
      action: 'edit',
      ids: [asset.id, second.id],
      changes: { custom_fields: { [visibleKey]: 'Green' } },
    });
    expect(await ok('GET', path, 'root')).toMatchObject({
      custom_fields: {
        Color: { value: 'Green' },
        'Destination code': { value: 'Default destination code' },
      },
    });
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

  it('protects fieldset associations and matches individual checkbox options alongside scalars', async () => {
    const { payload: options } = await ok('POST', '/fields', 'root', {
      name: 'Inventory options',
      element: 'checkbox',
      field_values: 'Laptop\nDock\nLaptop case',
    });
    const path = `/fields/${options.id}`;
    await ok('POST', `/fieldsets/${fieldset}/fields`, 'root', { field_id: options.id });
    expect((await http('DELETE', path, 'root')).statusCode).toBe(409);
    const first = await ok(
      'POST',
      '/hardware',
      'root',
      body('CheckboxFirst', westCompany, {
        [options.db_column]: ['Laptop', 'Dock'],
      }),
    );
    const second = await ok(
      'POST',
      '/hardware',
      'root',
      body('CheckboxSecond', westCompany, {
        [options.db_column]: ['Laptop case'],
      }),
    );
    const search = (key: string, value: string) =>
      ok(
        'GET',
        '/hardware?' +
          new URLSearchParams({ custom_field: key, custom_value: value, limit: '100' }),
        'root',
      );
    const { rows } = await search(options.db_column, 'Laptop');
    expect(rows.map(({ id }: { id: number }) => id)).toEqual([first.payload.id]);
    expect((await search(visibleKey, 'Blue')).rows).toContainEqual(
      expect.objectContaining({ id: second.payload.id }),
    );

    const { payload: temporary } = await ok('POST', '/fields', 'root', {
      name: 'Unused field',
      element: 'text',
    });
    await ok('POST', `/fieldsets/${fieldset}/fields`, 'root', { field_id: temporary.id });
    expect((await http('DELETE', `/fields/${temporary.id}`, 'root')).statusCode).toBe(409);
    await ok('POST', `/fields/${temporary.id}/disassociate`, 'root', { fieldset_id: fieldset });
    await ok('DELETE', `/fields/${temporary.id}`, 'root');
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

  it('allows check-in during a slow acceptance upload and cleans up the stale response', async () => {
    const asset = await create('UploadRace');
    const checked = await ok('POST', `/hardware/${asset.id}/checkout`, 'root', {
      target_type: 'user',
      target_id: west,
    });
    const id = checked.payload.acceptance_id;
    const storage = app.get<StorageProvider>(STORAGE_PROVIDER);
    const put = storage.putObject.bind(storage);
    let enterUpload!: () => void;
    let releaseUpload!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterUpload = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const remove = vi.spyOn(storage, 'deleteObject');
    const upload = vi.spyOn(storage, 'putObject').mockImplementation(async (category, ...args) => {
      if (category === 'eulas') {
        enterUpload();
        await released;
      }
      return put(category, ...args);
    });
    const response = http('POST', `/account/accept/${id}`, 'west', {
      decision: 'accept',
      signature: signature(),
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(
        () => reject(new Error('Inventory operation waited for storage')),
        2000,
      );
    });
    try {
      try {
        await Promise.race([entered, timeout]);
        await Promise.race([ok('POST', `/hardware/${asset.id}/checkin`, 'root'), timeout]);
      } finally {
        clearTimeout(deadline);
        releaseUpload();
      }
      expect((await response).statusCode).toBe(404);
      expect(remove.mock.calls.map(([category]) => category).sort()).toEqual([
        'eulas',
        'signatures',
      ]);
      expect(await ok('GET', `/hardware/${asset.id}`, 'west')).toMatchObject({ accepted: null });
    } finally {
      await response.catch(() => undefined);
      upload.mockRestore();
      remove.mockRestore();
    }
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

  it('blocks retirement of models with pending requests and preserves requester history', async () => {
    const categoryId = (await ok('GET', `/models/${model}`, 'root')).category_id;
    const { payload: target } = await ok('POST', '/models', 'root', {
      name: 'Request-only model',
      category_id: categoryId,
      requestable: true,
    });
    const { payload: request } = await ok('POST', `/account/request/models/${target.id}`, 'west');
    const modelPath = `/models/${target.id}`;
    expect((await http('DELETE', modelPath, 'root')).statusCode).toBe(409);
    await ok('POST', `/account/requests/${request.id}/cancel`, 'west');
    await ok('DELETE', modelPath, 'root');
    const history = await ok('GET', '/account/requests', 'west');
    expect(history.rows).toContainEqual(
      expect.objectContaining({
        id: request.id,
        state: 'canceled',
        item: 'Request-only model',
      }),
    );

    // A record imported with an already retired model remains cancelable by its owner.
    const [imported] = await db
      .insert(tables.checkoutRequests)
      .values({
        userId: west,
        requestableType: 'model',
        requestableId: target.id,
      })
      .returning({ id: tables.checkoutRequests.id });
    const own = await ok('GET', '/account/requests', 'west');
    expect(own.rows).toContainEqual(
      expect.objectContaining({ id: imported!.id, state: 'pending' }),
    );
    const staff = await ok('GET', '/requests', 'root');
    expect(staff.rows).not.toContainEqual(expect.objectContaining({ id: imported!.id }));
    const result = await ok('POST', `/account/requests/${imported!.id}/cancel`, 'west');
    expect(result.payload.state).toBe('canceled');
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
      const [requester] =
        await upgraded`insert into users (username) values ('legacy') returning id`;
      const duplicates = await upgraded`
        insert into checkout_requests (user_id, requestable_type, requestable_id)
        values (${requester!.id}, 'model', 1), (${requester!.id}, 'model', 1)
        returning id
      `;
      await expect(
        migrate(drizzle(upgraded), { migrationsFolder: migrations }),
      ).rejects.toMatchObject({
        code: '23505',
        constraint_name: 'uq_checkout_requests_pending_item',
      });
      expect(await upgraded`select state from checkout_requests order by id`).toEqual([
        { state: 'pending' },
        { state: 'pending' },
      ]);
      await upgraded`
        update checkout_requests set state = 'canceled', canceled_at = now() where id = ${duplicates[1]!.id}
      `;
      await migrate(drizzle(upgraded), { migrationsFolder: migrations });
      const [row] = await upgraded`select asset_tag, accepted from assets`;
      const [legacy] =
        await upgraded`select activated, inventory_only from users where id = ${requester!.id}`;
      expect(legacy).toEqual({ activated: false, inventory_only: false });
      expect(row).toMatchObject({ asset_tag: 'OLD-001', accepted: null });
      expect(await upgraded`select state from checkout_requests order by id`).toEqual([
        { state: 'pending' },
        { state: 'canceled' },
      ]);
    } finally {
      await upgraded.end();
      await rm(old, { recursive: true, force: true });
    }
  }, 20_000);
});

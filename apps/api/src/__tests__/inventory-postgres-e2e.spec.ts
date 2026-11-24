import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CryptoService } from '../common/crypto/crypto.service.js';
import { JwtService } from '../common/crypto/jwt.util.js';
import { STORAGE_PROVIDER, type StorageProvider } from '../common/storage/storage.interface.js';
import { DRIZZLE_DB, type DrizzleDb } from '../db/database.tokens.js';
import * as tables from '../db/schema/index.js';
import { OidcUserProvisioningService } from '../modules/auth/oidc-provisioning.service.js';
import { depreciationValue } from '../modules/inventory/depreciation.js';
import { REPORT_TYPES, IMPORT_TYPES, type PermissionMap } from '@kestrel-it/shared';
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { ImportsController } from '../modules/inventory/imports.controller.js';
import { NotificationsController } from '../modules/inventory/notifications.controller.js';
import {
  InventoryMailService,
  notificationEvents,
} from '../modules/inventory/inventory-mail.service.js';
import * as webhookDelivery from '../modules/inventory/webhook-delivery.js';
import { StorageDeletionService } from '../modules/inventory/storage-deletion.service.js';

const clusterUrl = process.env.INVENTORY_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../drizzle/', import.meta.url));
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type Token =
  | 'root' | 'west' | 'east' | 'admin' | 'westPat'
  | 'componentOperator' | 'linkedUser' | 'limitedReader' | 'statusReader' | 'noAssetReader'
  | 'firstEmailWriter' | 'secondEmailWriter';

describe.skipIf(!clusterUrl)('Inventory through Fastify and PostgreSQL 16', () => {
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
    await app.register(fastifyMultipart);
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
            'assets.audit': 1,
            'accessories.view': 1,
            'accessories.checkout': 1,
            'licenses.view': 1,
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
    const { webhook_endpoint, ...publicWebhook } = webhook;
    expect((await ok('PATCH', companyPath, 'root', webhook)).payload).toMatchObject({
      ...publicWebhook,
      webhook_configured: true,
    });
    expect(await ok('GET', companyPath, 'root')).not.toHaveProperty('webhook_endpoint');
    expect(await ok('GET', companyPath, 'admin')).not.toHaveProperty('webhook_endpoint');
    const { payload: company } = await ok('POST', '/companies', 'root', {
      name: 'Webhook company',
      ...webhook,
    });
    expect(company).toMatchObject({ ...publicWebhook, webhook_configured: true });
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
        cause: { code: '23505', constraint_name: 'uq_checkout_requests_pending_item' },
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
  it('rotates and retires license seats without exposing product keys', async () => {
    const data = (
      await ok('POST', '/licenses', 'root', {
        name: 'Scoped software',
        serial: 'private-product-key',
        company_id: westCompany,
        seats: 2,
        reassignable: false,
      })
    ).payload;
    expect(data.serial).toBe('private-product-key');
    expect((await ok('GET', `/licenses/${data.id}`, 'west')).serial).toBeNull();
    expect((await ok('GET', '/licenses?search=private-product-key', 'west')).total).toBe(0);
    expect((await http('GET', `/licenses/${data.id}`, 'east')).statusCode).toBe(403);
    const [seat] = (await ok('GET', `/licenses/${data.id}/seats`, 'root')).rows;
    await ok('POST', `/licenses/${data.id}/checkout`, 'root', {
      target_type: 'user',
      target_id: west,
      seat_id: seat.id,
    });
    expect(
      (
        await http('POST', `/licenses/${data.id}/checkout`, 'root', {
          target_type: 'user',
          target_id: east,
          seat_id: seat.id,
          reassign: true,
        })
      ).statusCode,
    ).toBe(409);
    await ok('POST', `/licenses/${data.id}/checkin`, 'root', { seat_id: seat.id });
    expect(
      (await ok('GET', `/licenses/${data.id}/seats/${seat.id}`, 'root')).unreassignable_seat,
    ).toBe(true);
    await ok('PATCH', `/licenses/${data.id}`, 'root', { seats: 1 });
    expect((await ok('GET', `/licenses/${data.id}`, 'west')).remaining).toBe(0);
    expect((await ok('GET', `/licenses/${data.id}/history`, 'root')).rows).not.toEqual([]);
    expect((await http('GET', `/licenses/${data.id}/history`, 'root')).body).not.toContain(
      'private-product-key',
    );
  });

  it('keeps a kit accessible when a model retirement conflicts with its composition', async () => {
    const currentModel = await ok('GET', `/models/${model}`, 'root');
    const { payload: member } = await ok('POST', '/models', 'root', {
      name: 'Kit retirement model',
      category_id: currentModel.category_id,
    });
    const { payload: kit } = await ok('POST', '/kits', 'root', { name: 'Kit retirement check' });
    await ok('POST', `/kits/${kit.id}/models`, 'root', { item_id: member.id, quantity: 1 });
    const blocked = await http('DELETE', `/models/${member.id}`, 'root');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body).toContain('predefined kits');
    expect(await ok('GET', `/kits/${kit.id}/models`, 'root')).toEqual([
      { id: member.id, name: member.name, quantity: 1 },
    ]);
    await ok('DELETE', `/kits/${kit.id}/models/${member.id}`, 'root');
    await ok('DELETE', `/models/${member.id}`, 'root');
    expect(await ok('GET', `/kits/${kit.id}/models`, 'root')).toEqual([]);
  });

  it('rolls back a losing kit and serializes competing adjustments', async () => {
    const category = (
      await ok('POST', '/categories', 'root', {
        name: 'Kit acceptance category',
        category_type: 'accessory',
        require_acceptance: true,
      })
    ).payload.id;
    const acc = (
      await ok('POST', '/accessories', 'root', {
        name: 'Kit accessory',
        qty: 2,
        company_id: westCompany,
        category_id: category,
      })
    ).payload.id;
    const consumable = (
      await ok('POST', '/consumables', 'root', {
        name: 'Last available kit item',
        qty: 1,
        company_id: westCompany,
      })
    ).payload.id;
    const kit = (await ok('POST', '/kits', 'root', { name: 'Limited onboarding kit' })).payload.id;
    await ok('POST', `/kits/${kit}/accessories`, 'root', { item_id: acc, quantity: 1 });
    await ok('POST', `/kits/${kit}/consumables`, 'root', { item_id: consumable, quantity: 1 });
    const results = await Promise.all(
      [1, 2].map(() => http('POST', `/kits/${kit}/checkout`, 'root', { user_id: west })),
    );
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const logs =
      await connection`select id from action_logs where item_type = 'accessory' and item_id = ${acc} and action_type = 'checkout'`;
    const acceptances =
      await connection`select id from checkout_acceptances where checkoutable_type = 'accessory' and checkoutable_id = ${acc}`;
    const mail =
      await connection`select channel from inventory_mail_outbox where subject = 'Inventory checked out: Kit accessory' order by channel`;
    expect([logs.length, acceptances.length]).toEqual([1, 1]);
    expect(mail).toEqual([{ channel: 'email' }, { channel: 'webhook' }]);
    expect((await ok('GET', '/account/accept', 'west')).rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: acceptances[0]!.id, item_type: 'accessory' }),
      ]),
    );
    await ok('POST', `/account/accept/${acceptances[0]!.id}`, 'west', {
      decision: 'accept',
      signature: signature(),
    });
    const competing = await Promise.all(
      [1, 2].map(() =>
        http('POST', `/accessories/${acc}/adjust-quantity`, 'root', {
          amount: -1,
          note: 'Count correction',
        }),
      ),
    );
    expect(competing.map((response) => response.statusCode).sort()).toEqual([201, 422]);
    const attempt = await http('POST', `/accessories/${acc}/adjust-quantity`, 'root', {
      amount: 3,
      unit_cost: '1.50',
      order_number: 'UNWRITTEN',
      supplier_id: 2147483647,
    });
    expect(attempt.statusCode).toBe(404);
    expect(await connection`select id from orders where order_number = 'UNWRITTEN'`).toHaveLength(
      0,
    );
    await ok('POST', `/accessories/${acc}/adjust-quantity`, 'root', {
      amount: 3,
      unit_cost: '1.50',
      order_number: 'KIT-ORDER',
      currency: 'EUR',
    });
    expect(
      (await ok('GET', `/order-items?item_type=accessory&item_id=${acc}`, 'west')).rows,
    ).toEqual([
      expect.objectContaining({
        order_number: 'KIT-ORDER',
        quantity: 3,
        unit_cost: '1.50',
        currency: 'EUR',
      }),
    ]);
    expect((await http('GET', '/order-items', 'west')).statusCode).toBe(403);
  });

  it('returns partial component quantities and records terminal consumption once', async () => {
    const asset = await create('COMPONENT-TARGET');
    const component = (
      await ok('POST', '/components', 'root', { name: 'Module', qty: 5, company_id: westCompany })
    ).payload.id;
    const [pivot] = (
      await ok('POST', `/components/${component}/checkout`, 'root', {
        target_type: 'asset',
        target_id: asset.id,
        quantity: 4,
      })
    ).payload.assignment_ids;
    await ok('POST', `/components/${pivot}/checkin`, 'root', { quantity: 2 });
    expect((await ok('GET', `/components/${component}`, 'root')).remaining).toBe(3);
    expect((await http('DELETE', `/components/${component}`, 'root')).statusCode).toBe(409);
    await ok('POST', `/components/${pivot}/checkin`, 'root', {});
    const consumable = (
      await ok('POST', '/consumables', 'root', {
        name: 'Terminal consumable',
        qty: 1,
        min_amt: 1,
        company_id: westCompany,
      })
    ).payload.id;
    const [issue] = (
      await ok('POST', `/consumables/${consumable}/checkout`, 'root', {
        target_type: 'user',
        target_id: west,
      })
    ).payload.assignment_ids;
    const endpoint = `/consumables/${consumable}/consume/${issue}`;
    expect((await ok('POST', endpoint, 'root')).payload.consumed).toBe(1);
    expect((await ok('POST', endpoint, 'root')).payload.consumed).toBe(0);
    expect(
      (await http('POST', `/consumables/${consumable}/adjust-quantity`, 'root', { amount: -1 }))
        .statusCode,
    ).toBe(422);
    expect((await ok('GET', '/low-stock?search=Terminal%20consumable', 'root')).rows).toEqual([
      expect.objectContaining({ id: consumable, type: 'consumables', remaining: 0 }),
    ]);
    expect((await ok('GET', '/low-stock?search=Terminal%20consumable', 'west')).total).toBe(0);
  });

  it('records mixed audits, protects photos, and projects only visible calendar sources', async () => {
    const visible = await create('AUDIT-WEST');
    const hidden = await create('AUDIT-EAST', eastCompany);
    const audits = await ok('POST', '/hardware/audit/bulk', 'west', {
      ids: [visible.id, hidden.id],
      next_audit_date: '2040-03-03',
      note: 'Mixed audit',
    });
    expect(audits.results.map((row: { status: string }) => row.status)).toEqual([
      'success',
      'error',
    ]);
    await ok('POST', `/hardware/${hidden.id}/audit`, 'root', { next_audit_date: '2040-03-04' });
    const calendar = '/calendar/events?start=2040-03-01&end=2040-04-01&event_type=asset.audit_due';
    expect((await ok('GET', calendar, 'west')).total).toBe(1);
    expect((await ok('GET', calendar, 'root')).total).toBe(2);
    const boundary = 'phase-three-audit-boundary';
    const png = PNG.sync.write(new PNG({ width: 12, height: 12 }));
    const multipart = (data: object) =>
      Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="audit.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        png,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/hardware/${visible.id}/audit`,
      payload: multipart({ next_audit_date: '2040-03-05' }),
      headers: {
        authorization: 'Bearer ' + tokens.get('west'),
        'content-type': 'multipart/form-data; boundary=' + boundary,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const endpoint = `/hardware/${visible.id}/audits/${response.json().payload.audit_id}/photo`;
    expect((await http('GET', endpoint, 'west')).rawPayload).toEqual(png);
    expect((await http('GET', endpoint, 'east')).statusCode).toBe(404);
    const stored = await readdir(join(storageRoot, 'audits'));
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/v1/hardware/${visible.id}/audit`,
      payload: multipart({
        location_id: eastLocation,
        update_location: true,
        next_audit_date: '2040-03-06',
      }),
      headers: {
        authorization: 'Bearer ' + tokens.get('west'),
        'content-type': 'multipart/form-data; boundary=' + boundary,
      },
    });
    expect(invalid.statusCode).toBe(422);
    expect(await readdir(join(storageRoot, 'audits'))).toEqual(stored);
    expect((await ok('GET', calendar, 'west')).events).toEqual([
      expect.objectContaining({ start: '2040-03-05' }),
    ]);
    await ok('DELETE', `/hardware/${visible.id}`, 'root');
    expect((await ok('GET', calendar, 'west')).total).toBe(0);
  });

  it('completes maintenance once and applies depreciation floors to all methods', async () => {
    const asset = await create('MAINTENANCE-ASSET');
    const types = await ok('GET', '/maintenance-types', 'root');
    expect(types.total).toBe(8);
    const type = (await ok('POST', '/maintenance-types', 'root', { name: 'Inspections' })).payload
      .id;
    const item = (
      await ok('POST', '/maintenances', 'root', {
        name: 'Brake inspection',
        asset_id: asset.id,
        maintenance_type_id: type,
        start_date: '2024-01-01',
        is_warranty: true,
        cost: '15.00',
      })
    ).payload.id;
    expect((await http('DELETE', `/maintenance-types/${type}`, 'root')).statusCode).toBe(409);
    expect((await http('GET', `/maintenances/${item}`, 'east')).statusCode).toBe(404);
    const finished = await Promise.all(
      [1, 2].map(() =>
        http('POST', `/maintenances/${item}/complete`, 'root', {
          completed_at: '2024-01-10',
          note: 'Fixed',
        }),
      ),
    );
    expect(finished.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect((await ok('GET', `/maintenances/${item}`, 'west')).duration_days).toBe(9);
    const plan = (
      await ok('POST', '/depreciations', 'root', {
        name: 'Fixed floor plan',
        months: 12,
        depreciation_min: '500',
        depreciation_type: 'amount',
        fiscal_year_start_month: 7,
      })
    ).payload;
    expect((await ok('GET', `/depreciations/${plan.id}`, 'root')).depreciation_min).toBe('500.00');
  });

  async function multipart(
    path: string,
    actor: Token,
    filename: string,
    bytes: Buffer,
    mime: string,
  ) {
    const boundary = 'kestrel-parity-boundary';
    return app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: {
        authorization: 'Bearer ' + tokens.get(actor),
        'content-type': 'multipart/form-data; boundary=' + boundary,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
  }

  it('matches attachment parent and model read/write policy', async () => {
    const asset = await create('file-parity');
    const before = (await ok('GET', `/models/${model}/files`, 'west')).total;
    const document = Buffer.from('Inventory manual');
    const upload = await multipart(
      `/models/${model}/files`,
      'root',
      'manual.txt',
      document,
      'text/plain',
    );
    expect(upload.statusCode, upload.body).toBe(201);
    const file = upload.json().payload[0];
    expect((await ok('GET', `/models/${model}/files?search=manual`, 'west')).total).toBe(
      before + 1,
    );
    expect((await http('GET', `/models/${model}/files/${file.id}`, 'west')).rawPayload).toEqual(
      document,
    );
    expect(
      (await multipart(`/models/${model}/files`, 'west', 'edit.txt', document, 'text/plain'))
        .statusCode,
    ).toBe(403);
    expect(
      (await http('DELETE', `/models/${model}/files/${file.id}/delete`, 'west')).statusCode,
    ).toBe(403);
    expect((await http('GET', `/assets/${asset.id}/files/${file.id}`, 'root')).statusCode).toBe(
      404,
    );
    expect(
      (
        await multipart(
          `/hardware/${asset.id}/files`,
          'root',
          'unsafe.svg',
          Buffer.from('<svg/>'),
          'image/svg+xml',
        )
      ).statusCode,
    ).toBe(422);
    await ok('DELETE', `/models/${model}/files/${file.id}/delete`, 'root');
    expect((await http('GET', `/models/${model}/files/${file.id}`, 'west')).statusCode).toBe(404);
    expect(await app.get(StorageDeletionService).deleteOne()).toBe(true);
  });

  it('checks the current and upload company for attachments after a hardware transfer', async () => {
    await db.update(tables.users)
      .set({ permissions: sql`${tables.users.permissions} || '{"assets.files":1}'::jsonb` })
      .where(inArray(tables.users.id, [west, east]));
    try {
      const asset = await create('file-company-transfer');
      const path = `/hardware/${asset.id}/files`;
      const upload = await multipart(path, 'west', 'original.txt', Buffer.from('Original company document'), 'text/plain');
      expect(upload.statusCode, upload.body).toBe(201);
      const [{ id }] = upload.json().payload;
      expect((await ok('GET', path, 'west')).total).toBe(1);
      expect((await http('GET', `${path}/${id}`, 'west')).statusCode).toBe(200);
      const storage = app.get<StorageProvider>(STORAGE_PROVIDER);
      const putObject = storage.putObject.bind(storage);
      let enterUpload!: () => void;
      let releaseUpload!: () => void;
      const entered = new Promise<void>((resolve) => { enterUpload = resolve; });
      const released = new Promise<void>((resolve) => { releaseUpload = resolve; });
      const slow = vi.spyOn(storage, 'putObject').mockImplementation(async (...args) => {
        await putObject(...args);
        enterUpload();
        await released;
      });
      const staged = multipart(path, 'root', 'staged.txt', Buffer.from('Staged document'), 'text/plain');
      try {
        await Promise.race([
          entered,
          staged.then(() => { throw new Error('Upload finished before the transfer'); }),
        ]);
        await ok('PATCH', `/hardware/${asset.id}`, 'root', {
          company_id: eastCompany,
          rtd_location_id: eastLocation,
        });
        const [, stagedKey] = slow.mock.calls[0]!;
        releaseUpload();
        expect((await staged).statusCode).toBe(409);
        expect(await storage.exists('assets', stagedKey)).toBe(false);
      } finally {
        releaseUpload();
        await staged;
        slow.mockRestore();
      }
      expect((await http('GET', path, 'west')).statusCode).toBe(404);
      const newUpload = await multipart(path, 'east', 'received.txt', Buffer.from('Receiving company document'), 'text/plain');
      expect(newUpload.statusCode, newUpload.body).toBe(201);
      const [{ id: newId }] = newUpload.json().payload;
      expect((await ok('GET', path, 'east')).total).toBe(1);
      expect((await ok('GET', path, 'east')).rows[0].id).toBe(newId);
      expect((await http('GET', `${path}/${id}`, 'east')).statusCode).toBe(404);
      expect((await http('DELETE', `${path}/${id}`, 'east')).statusCode).toBe(404);
      expect((await ok('GET', path, 'root')).total).toBe(2);
      expect((await http('GET', `${path}/${id}`, 'root')).statusCode).toBe(200);
    } finally {
      await db.update(tables.users)
        .set({ permissions: sql`${tables.users.permissions} - 'assets.files'` })
        .where(inArray(tables.users.id, [west, east]));
    }
  });

  it('keeps shared location attachments accessible when FMCS location scoping is disabled', async () => {
    await db.update(tables.users)
      .set({ permissions: sql`${tables.users.permissions} || '{"locations.files":1}'::jsonb` })
      .where(eq(tables.users.id, west));
    const [sharedNull] = await db
      .insert(tables.locations)
      .values({ name: 'Shared null-company location', companyId: null })
      .returning({ id: tables.locations.id });
    await db.update(tables.settings).set({ scopeLocationsFmcs: false });
    try {
      for (const locationId of [eastLocation, sharedNull!.id]) {
        const path = `/locations/${locationId}/files`;
        const content = Buffer.from(`Shared location document ${locationId}`);
        const upload = await multipart(path, 'west', 'shared.txt', content, 'text/plain');
        expect(upload.statusCode, upload.body).toBe(201);
        const [{ id }] = upload.json().payload;
        expect((await ok('GET', path, 'west')).rows).toContainEqual(
          expect.objectContaining({ id, filename: 'shared.txt' }),
        );
        expect((await http('GET', `${path}/${id}`, 'west')).rawPayload).toEqual(content);
        await ok('DELETE', `${path}/${id}`, 'west');
        expect((await http('GET', `${path}/${id}`, 'west')).statusCode).toBe(404);
        expect(await app.get(StorageDeletionService).deleteOne()).toBe(true);
      }
      await db.update(tables.settings).set({ scopeLocationsFmcs: true });
      expect((await http('GET', `/locations/${eastLocation}/files`, 'west')).statusCode).toBe(404);
    } finally {
      await db.update(tables.settings).set({ scopeLocationsFmcs: true });
      await db.update(tables.users)
        .set({ permissions: sql`${tables.users.permissions} - 'locations.files'` })
        .where(eq(tables.users.id, west));
    }
  });

  it('commits file deletions before storage cleanup and retries without blocking other inventory writes', async () => {
    const asset = await create('file-cleanup');
    const path = `/hardware/${asset.id}/files`;
    const document = await multipart(path, 'root', 'manual.txt', Buffer.from('Manual'), 'text/plain');
    const csv = await multipart('/imports', 'root', 'cleanup.csv', Buffer.from('Name\nWidget'), 'text/csv');
    expect(document.statusCode, document.body).toBe(201);
    expect(csv.statusCode, csv.body).toBe(201);
    const [{ id: attachment }] = document.json().payload;
    const [{ id: imported }] = csv.json().payload;
    const store = app.get<StorageProvider>(STORAGE_PROVIDER);
    await db.execute(sql`alter table storage_deletion_queue
      add constraint test_reject_deletion_queue check (false) not valid`);
    try {
      expect((await http('DELETE', `${path}/${attachment}`, 'root')).statusCode).toBe(500);
      expect((await http('DELETE', `/imports/${imported}`, 'root')).statusCode).toBe(500);
      expect((await http('GET', `${path}/${attachment}`, 'root')).body).toBe('Manual');
      expect((await http('GET', `/imports/${imported}/download`, 'root')).body).toBe('Name\nWidget');
    } finally {
      await db.execute(sql`alter table storage_deletion_queue drop constraint test_reject_deletion_queue`);
    }
    const failure = vi.spyOn(store, 'deleteObject').mockRejectedValueOnce(new Error('Storage unavailable'));
    const cleanup = app.get(StorageDeletionService);
    try {
      await ok('DELETE', `${path}/${attachment}`, 'root');
      await ok('DELETE', `/imports/${imported}`, 'root');
      expect(failure).not.toHaveBeenCalled();
      expect((await http('GET', `${path}/${attachment}`, 'root')).statusCode).toBe(404);
      expect((await http('GET', `/imports/${imported}/download`, 'root')).statusCode).toBe(404);
      expect(await cleanup.deleteOne()).toBe(true);
      const [retry] = await db.select().from(tables.storageDeletionQueue)
        .where(eq(tables.storageDeletionQueue.attempts, 1));
      expect(retry).toBeDefined();
      expect(await store.exists(retry!.category, retry!.objectKey)).toBe(true);
      expect(await cleanup.deleteOne()).toBe(true);
    } finally {
      failure.mockRestore();
    }

    const deleteObject = store.deleteObject.bind(store);
    let enterDelete!: () => void;
    let releaseDelete!: () => void;
    const entered = new Promise<void>((resolve) => { enterDelete = resolve; });
    const released = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const slow = vi.spyOn(store, 'deleteObject').mockImplementation(async (...args) => {
      enterDelete();
      await released;
      await deleteObject(...args);
    });
    const pending = cleanup.deleteOne(new Date(Date.now() + 120_000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Inventory write waited for storage cleanup')), 2_000);
    });
    try {
      await Promise.race([entered, timeout]);
      await Promise.race([create('unrelated-while-cleaning'), timeout]);
      expect(await cleanup.deleteOne(new Date(Date.now() + 120_000))).toBe(false);
    } finally {
      clearTimeout(timer);
      releaseDelete();
      await pending;
      slow.mockRestore();
    }
    expect(await db.select().from(tables.storageDeletionQueue)).toEqual([]);
  });

  it('prints asset labels as valid PDF and rejects an out-of-scope tag', async () => {
    const westAsset = await create('barcode-west');
    const eastAsset = await create('barcode-east', eastCompany);
    const print = await http('POST', '/hardware/labels', 'west', {
      asset_tags: [westAsset.asset_tag],
    });
    expect(print.statusCode, print.body).toBe(200);
    expect(Buffer.from(print.json().payload.pdf, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    expect(
      (
        await http('POST', '/hardware/labels', 'west', {
          asset_tags: [westAsset.asset_tag, eastAsset.asset_tag],
        })
      ).statusCode,
    ).toBe(404);
    const binary = await http('POST', '/hardware/labels', 'west', {
      asset_tags: [westAsset.asset_tag],
      format: 'pdf',
    });
    expect(binary.headers['content-type']).toContain('application/pdf');
    expect(binary.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('renders the purchase date as text on a printed label', async () => {
    const asset = (await ok('POST', '/hardware', 'root', {
      ...body('label-purchase-date'),
      purchase_date: '2024-09-25',
    })).payload;
    const name = 'Purchase date test';
    await ok('POST', '/labels', 'root', {
      name,
      layout: { width: 2, height: 1, page_width: 2, page_height: 1, fields: ['purchase_date'], barcode: 'none', code2d: 'none' },
    });
    const response = await http('POST', '/hardware/labels', 'root', {
      asset_tags: [asset.asset_tag],
      template: name,
      format: 'pdf',
    });
    expect(response.statusCode, response.body).toBe(200);
    const streams = response.rawPayload.toString('latin1').matchAll(/stream\n([\s\S]+?)\nendstream/g);
    const printed = [...streams].map(([, stream]) => {
      const content = inflateSync(Buffer.from(stream!, 'latin1')).toString();
      return [...content.matchAll(/<([\da-f]+)>/g)]
        .map(([, hex]) => Buffer.from(hex!, 'hex').toString())
        .join('');
    }).join('');
    expect(printed).toContain('2024-09-25');
    expect(printed).not.toContain('[object Object]');
  });

  it('configures depreciation for superusers and ranks scoped book values before pagination and export', async () => {
    const settings = '/depreciations/settings';
    expect((await http('GET', settings, 'west')).statusCode).toBe(403);
    expect((await http('PATCH', settings, 'admin', { depreciation_method: 'half_2' })).statusCode).toBe(403);
    expect((await http('PATCH', settings, 'root', { depreciation_method: 'invalid' })).statusCode).toBe(422);
    for (const method of ['half_1', 'half_2', 'diminish', 'default']) {
      await ok('PATCH', settings, 'root', { depreciation_method: method });
      expect((await ok('GET', settings, 'root')).payload.depreciation_method).toBe(method);
    }
    const { payload: schedule } = await ok('POST', '/depreciations', 'root', { name: 'Sorting schedule', months: 60 });
    const base = await ok('GET', `/models/${model}`, 'root');
    const { payload: depreciating } = await ok('POST', '/models', 'root', {
      name: 'Depreciation sorting model',
      category_id: base.category_id,
      depreciation_id: schedule.id,
    });
    for (const [date, cost, company] of [
      ['2020-01-01', '800', westCompany],
      ['2023-07-01', '800', westCompany],
      ['2020-01-01', '1', eastCompany],
    ] as const) {
      await ok('POST', '/hardware', 'root', {
        ...body('book-' + date + company, company),
        model_id: depreciating.id,
        custom_fields: {},
        purchase_date: date,
        purchase_cost: cost,
      });
    }
    await db.update(tables.users)
      .set({ permissions: sql`${tables.users.permissions} || '{"reports.view":1}'::jsonb` })
      .where(eq(tables.users.id, west));
    try {
      const selection = `/reports/depreciation?model_id=${depreciating.id}&as_of=2024-07-01&sort=book_value&columns=book_value`;
      expect(await ok('GET', selection + '&limit=1&order=asc', 'west')).toMatchObject({
        total: 2, rows: [{ book_value: '80.00' }],
      });
      expect((await ok('GET', selection + '&limit=1&page=2&order=asc', 'west')).rows)
        .toEqual([{ book_value: '640.00' }]);
      expect((await ok('GET', selection + '&limit=1&order=desc', 'west')).rows)
        .toEqual([{ book_value: '640.00' }]);
      const bookSearch = `/reports/depreciation?model_id=${depreciating.id}&as_of=2024-07-01&columns=asset_tag,book_value`;
      expect(await ok('GET', bookSearch + '&search=640.00', 'west')).toMatchObject({
        total: 1,
        rows: [expect.objectContaining({ book_value: '640.00' })],
      });
      expect(await ok('GET', bookSearch + '&search=80.00&sort=book_value&order=asc', 'west')).toMatchObject({
        total: 1,
        rows: [expect.objectContaining({ book_value: '80.00' })],
      });
      const executeSpy = vi.spyOn(db, 'execute');
      try {
        expect((await ok('GET', bookSearch + '&search=book-2023-07-01', 'west')).total).toBe(1);
        const tagQueries = executeSpy.mock.calls.map(([query]) => JSON.stringify(query));
        expect(tagQueries.some((query) => query.includes('_sql_match'))).toBe(false);
      } finally {
        executeSpy.mockRestore();
      }
      expect((await ok('GET', bookSearch + '&search=999.99', 'west')).total).toBe(0);
      const searchedCsv = await http('GET', bookSearch + '&search=640.00&format=csv', 'west');
      expect(parseCsv(searchedCsv.body, { columns: true })).toEqual([
        expect.objectContaining({ book_value: '640.00' }),
      ]);
      const csv = await http('GET', selection + '&format=csv&order=asc', 'west');
      expect(parseCsv(csv.body, { columns: true })).toEqual([{ book_value: '80.00' }, { book_value: '640.00' }]);
      const xlsx = await http('GET', selection + '&format=xlsx&order=desc', 'west');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(new Uint8Array(xlsx.rawPayload).buffer);
      expect(workbook.getWorksheet(1)?.getColumn(1).values).toEqual([, 'book_value', '640.00', '80.00']);
    } finally {
      await db.update(tables.users)
        .set({ permissions: sql`${tables.users.permissions} - 'reports.view'` })
        .where(eq(tables.users.id, west));
    }
  });

  it('offers all ten reports in both formats and protects masked data and scoped activity', async () => {
    const westAsset = (
      await ok('POST', '/hardware', 'root', {
        ...body('report-west'),
        name: '=Formula-like asset',
        notes: 'Line one\nLine two',
      })
    ).payload;
    const eastAsset = await create('report-east', eastCompany);
    for (const type of REPORT_TYPES) {
      const preview = await ok('GET', `/reports/${type}?limit=1`, 'root');
      const csv = await http('GET', `/reports/${type}?format=csv`, 'root');
      expect(csv.statusCode, `CSV ${type}: ${csv.body.slice(0, 300)}`).toBe(200);
      const records = parseCsv(csv.body) as string[][];
      expect(records[0]).toEqual(preview.columns);
      expect(records.length - 1).toBe(preview.total);
      const xlsx = await http('GET', `/reports/${type}?format=xlsx`, 'root');
      expect(xlsx.statusCode, `XLSX ${type}`).toBe(200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(new Uint8Array(xlsx.rawPayload).buffer);
      expect(workbook.worksheets[0]!.getRow(1).values).toEqual([, ...preview.columns]);
    }
    const csv = await http(
      'GET',
      '/reports/custom?format=csv&columns=asset_tag,name,notes',
      'root',
    );
    expect(parseCsv(csv.body)).toContainEqual([
      westAsset.asset_tag,
      "'=Formula-like asset",
      'Line one\nLine two',
    ]);
    const scoped = await ok(
      'GET',
      '/reports/activity?scoped=true&item_type=asset&limit=100',
      'west',
    );
    expect(scoped.rows).toContainEqual(expect.objectContaining({ item_id: westAsset.id }));
    expect(scoped.rows).not.toContainEqual(expect.objectContaining({ item_id: eastAsset.id }));
    expect((await http('GET', '/reports/licenses', 'west')).statusCode).toBe(403);
    const report = await ok('POST', '/report-templates', 'root', {
      name: 'Private inventory report',
      report: 'custom',
      options: { columns: 'asset_tag,name' },
    });
    expect(
      (await ok('GET', `/report-templates/${report.payload.id}`, 'root')).payload.options.columns,
    ).toBe('asset_tag,name');
    await db
      .update(tables.users)
      .set({ permissions: sql`${tables.users.permissions} || '{"reports.view":1}'::jsonb` })
      .where(eq(tables.users.id, west));
    expect((await http('GET', `/report-templates/${report.payload.id}`, 'west')).statusCode).toBe(
      404,
    );
    await ok('PATCH', `/report-templates/${report.payload.id}`, 'root', {
      name: 'Shared inventory report',
      report: 'custom',
      is_shared: true,
      options: { columns: 'asset_tag,name' },
    });
    expect(
      (await ok('GET', `/report-templates/${report.payload.id}`, 'west')).payload.isShared,
    ).toBe(true);
    expect(
      (await http('DELETE', `/report-templates/${report.payload.id}`, 'west')).statusCode,
    ).toBe(404);
    await db
      .update(tables.users)
      .set({ permissions: sql`${tables.users.permissions} - 'reports.view'` })
      .where(eq(tables.users.id, west));
  }, 30_000);

  it('uses the CSV company to resolve same-name locations without creating duplicates', async () => {
    const [westSite] = await db.insert(tables.locations).values([
      { name: 'Shared import location', companyId: westCompany },
      { name: 'Shared import location', companyId: eastCompany },
    ]).returning({ id: tables.locations.id });
    const tag = 'IMPORT-COMPANY-LOCATION';
    const csv = 'Asset Tag,Model,Company,Location\n' +
      `${tag},Imported company location model,West division,Shared import location`;
    const upload = await multipart('/imports', 'root', 'company-location.csv', Buffer.from(csv), 'text/csv');
    expect(upload.statusCode, upload.body).toBe(201);
    const [{ id }] = upload.json().payload;
    await ok('POST', `/imports/process/${id}`, 'root', {
      import_type: 'asset',
      field_map: { 0: 'asset_tag', 1: 'model', 2: 'company', 3: 'location' },
    });
    await app.get(ImportsController).processOne();
    const result = await ok('GET', `/imports/${id}/progress`, 'root');
    expect(result.run).toMatchObject({ created: 1, errored: 0 });
    const [imported] = await db.select().from(tables.assets).where(eq(tables.assets.assetTag, tag));
    expect(imported).toMatchObject({ companyId: westCompany, locationId: westSite!.id });
    expect(await db.select().from(tables.locations).where(eq(tables.locations.name, 'Shared import location')))
      .toHaveLength(2);

    const [westUpdatedSite] = await db.insert(tables.locations).values([
      { name: 'Updated import location', companyId: westCompany },
      { name: 'Updated import location', companyId: eastCompany },
    ]).returning({ id: tables.locations.id });
    const updateCsv = `Asset Tag,Location\n${tag},Updated import location`;
    const updateUpload = await multipart(
      '/imports',
      'root',
      'update-without-company.csv',
      Buffer.from(updateCsv),
      'text/csv',
    );
    expect(updateUpload.statusCode, updateUpload.body).toBe(201);
    const [{ id: updateId }] = updateUpload.json().payload;
    await ok('POST', `/imports/process/${updateId}`, 'root', {
      import_type: 'asset',
      update_existing: true,
      field_map: { 0: 'asset_tag', 1: 'location' },
    });
    await app.get(ImportsController).processOne();
    expect((await ok('GET', `/imports/${updateId}/progress`, 'root')).run).toMatchObject({
      updated: 1,
      errored: 0,
    });
    const [updated] = await db.select().from(tables.assets).where(eq(tables.assets.assetTag, tag));
    expect(updated).toMatchObject({ companyId: westCompany, locationId: westUpdatedSite!.id });
    expect(
      await db.select().from(tables.locations).where(eq(tables.locations.name, 'Updated import location')),
    ).toHaveLength(2);

    const [, eastDefaultSite] = await db.insert(tables.locations).values([
      { name: 'Default company import location', companyId: westCompany },
      { name: 'Default company import location', companyId: eastCompany },
    ]).returning({ id: tables.locations.id });
    await db.update(tables.settings).set({ scopeLocationsFmcs: false });
    await db
      .update(tables.users)
      .set({
        permissions: sql`${tables.users.permissions} || '{"import":1,"assets.create":1}'::jsonb`,
      })
      .where(eq(tables.users.id, east));
    try {
      const defaultTag = 'IMPORT-DEFAULT-COMPANY-LOCATION';
      const defaultCsv =
        'Asset Tag,Model,Location\n' +
        `${defaultTag},Imported company location model,Default company import location`;
      const defaultUpload = await multipart(
        '/imports',
        'east',
        'default-company-location.csv',
        Buffer.from(defaultCsv),
        'text/csv',
      );
      expect(defaultUpload.statusCode, defaultUpload.body).toBe(201);
      const [{ id: defaultId }] = defaultUpload.json().payload;
      await ok('POST', `/imports/process/${defaultId}`, 'east', {
        import_type: 'asset',
        field_map: { 0: 'asset_tag', 1: 'model', 2: 'location' },
      });
      await app.get(ImportsController).processOne();
      expect((await ok('GET', `/imports/${defaultId}/progress`, 'east')).run).toMatchObject({
        created: 1,
        errored: 0,
      });
      const [createdDefault] = await db
        .select()
        .from(tables.assets)
        .where(eq(tables.assets.assetTag, defaultTag));
      expect(createdDefault).toMatchObject({
        companyId: eastCompany,
        locationId: eastDefaultSite!.id,
      });
      expect(
        await db
          .select()
          .from(tables.locations)
          .where(eq(tables.locations.name, 'Default company import location')),
      ).toHaveLength(2);
    } finally {
      await db.update(tables.settings).set({ scopeLocationsFmcs: true });
      await db
        .update(tables.users)
        .set({ permissions: sql`${tables.users.permissions} - 'import' - 'assets.create'` })
        .where(eq(tables.users.id, east));
    }
  });

  it('scopes location updates and preserves required user companies in shared-location imports', async () => {
    const twin = 'FMCS import twin';
    const shared = 'FMCS import shared';
    const unassigned = 'FMCS import unassigned';
    const [westTwin, eastTwin, westShared, unassignedSite] = await db
      .insert(tables.locations)
      .values([
        { name: twin, companyId: westCompany, city: 'West' },
        { name: twin, companyId: eastCompany, city: 'East' },
        { name: shared, companyId: westCompany, city: 'West' },
        { name: unassigned },
        { name: unassigned, companyId: westCompany },
      ])
      .returning({ id: tables.locations.id });
    const [operator] = await db.select({ permissions: tables.users.permissions })
      .from(tables.users).where(eq(tables.users.id, east));
    await db.update(tables.settings).set({ scopeLocationsFmcs: false });
    await db.update(tables.users).set({
      permissions: {
        ...operator!.permissions,
        import: 1, 'assets.create': 1, 'locations.create': 1, 'locations.edit': 1,
        'users.create': 1, 'users.edit': 1,
      },
    }).where(eq(tables.users.id, east));

    async function runCsv(
      type: (typeof IMPORT_TYPES)[number],
      fieldMap: Record<number, string>,
      csv: string,
      actor: Token = 'east',
    ) {
      const upload = await multipart('/imports', actor, 'company-scope.csv', Buffer.from(csv), 'text/csv');
      expect(upload.statusCode, upload.body).toBe(201);
      const [{ id }] = upload.json().payload;
      await ok('POST', `/imports/process/${id}`, actor, {
        import_type: type, field_map: fieldMap, update_existing: true, preserve_blanks: false,
      });
      await app.get(ImportsController).processOne();
      return (await ok('GET', `/imports/${id}/progress`, actor)).run;
    }

    try {
      const modelName = 'FMCS shared-location import model';
      const baseModel = await ok('GET', `/models/${model}`, 'root');
      await ok('POST', '/models', 'root', { name: modelName, category_id: baseModel.category_id });
      const assetFields = { 0: 'asset_tag', 1: 'model', 2: 'company', 3: 'location' };
      expect(await runCsv('asset', assetFields,
        `Asset Tag,Model,Company,Location\nFMCS-SHARED,${modelName},,${shared}`,
      )).toMatchObject({ created: 1, errored: 0 });
      const [linked] = await db.select().from(tables.assets).where(eq(tables.assets.assetTag, 'FMCS-SHARED'));
      expect(linked).toMatchObject({ companyId: eastCompany, locationId: westShared!.id });
      expect(await db.select().from(tables.locations).where(eq(tables.locations.name, shared))).toHaveLength(1);

      expect(await runCsv('asset', assetFields,
        `Asset Tag,Model,Company,Location\nFMCS-GLOBAL,${modelName},,${unassigned}`, 'root',
      )).toMatchObject({ created: 1, errored: 0 });
      const [global] = await db.select().from(tables.assets).where(eq(tables.assets.assetTag, 'FMCS-GLOBAL'));
      expect(global).toMatchObject({ companyId: null, locationId: unassignedSite!.id });

      expect(await runCsv('location', { 0: 'name', 1: 'city' },
        `Name,City\n${twin},Milan`,
      )).toMatchObject({ updated: 1, errored: 0 });
      expect(await runCsv('location', { 0: 'name', 1: 'company', 2: 'city' },
        `Name,Company,City\n${twin},,Turin\n${shared},,East office`,
      )).toMatchObject({ created: 1, updated: 1, errored: 0 });
      const sites = await db.select().from(tables.locations)
        .where(inArray(tables.locations.name, [twin, shared]));
      expect(sites).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: westTwin!.id, companyId: westCompany, city: 'West' }),
        expect.objectContaining({ id: eastTwin!.id, companyId: eastCompany, city: 'Turin' }),
        expect.objectContaining({ id: westShared!.id, companyId: westCompany, city: 'West' }),
        expect.objectContaining({ name: shared, companyId: eastCompany, city: 'East office' }),
      ]));

      const userName = 'fmcs-import-user';
      const userFields = { 0: 'username', 1: 'company', 2: 'first_name' };
      expect(await runCsv('user', userFields, `Username,Company,First Name\n${userName},,New`))
        .toMatchObject({ created: 1, errored: 0 });
      const [recipient] = await db.select().from(tables.users).where(eq(tables.users.username, userName));
      const memberships = () => db.select({ id: tables.companyUser.companyId }).from(tables.companyUser)
        .where(eq(tables.companyUser.userId, recipient!.id)).orderBy(tables.companyUser.companyId);
      expect(await memberships()).toEqual([{ id: eastCompany }]);
      await db.insert(tables.companyUser).values({ userId: recipient!.id, companyId: westCompany });
      expect(await runCsv('user', userFields, `Username,Company,First Name\n${userName},,Edited`))
        .toMatchObject({ updated: 1, errored: 0 });
      expect(await memberships()).toEqual([{ id: westCompany }, { id: eastCompany }]);
    } finally {
      await db.update(tables.settings).set({ scopeLocationsFmcs: true });
      await db.update(tables.users).set({ permissions: operator!.permissions }).where(eq(tables.users.id, east));
    }
  });

  it('runs all twelve upstream import types and keeps historical checkouts out of live state', async () => {
    const csvs: Record<(typeof IMPORT_TYPES)[number], string> = {
      asset: 'Asset Tag,Model,Status,Asset Name\nCSV-ASSET,CSV Model,Deployed,CSV fixture asset',
      assetHistory:
        'Asset Tag,Assigned To,Checkout Date,Checkin Date\nCSV-ASSET,west,2025-04-01,2025-04-06',
      assetModel: 'Name,Model Number,Category\nCSV Model,CSV-123,CSV asset category',
      user: 'Username,Email,First Name,Last Name\ncsv-user,csv-user@example.test,Csv,User',
      license: 'Name,Product Key,Seats\nCSV License,PRIVATE-CSV-KEY,2',
      accessory: 'Name,Quantity\nCSV Accessory,10',
      consumable: 'Name,Item Number,Quantity\nCSV Consumable,CSV-C,10',
      component: 'Name,Serial,Quantity\nCSV Component,CSV-CM,10',
      location: 'Name,City\nCSV Location,Rome',
      category: 'Name,Category Type\nCSV asset category,asset',
      manufacturer: 'Name,Support URL\nCSV Manufacturer,https://example.test/support',
      supplier: 'Name,City\nCSV Supplier,Rome',
    };
    const ordered = [
      'category',
      'assetModel',
      'asset',
      'assetHistory',
      ...IMPORT_TYPES.filter(
        (type) => !['category', 'assetModel', 'asset', 'assetHistory'].includes(type),
      ),
    ] as (typeof IMPORT_TYPES)[number][];
    for (const type of ordered) {
      const uploaded = await multipart(
        '/imports',
        'root',
        `${type}.csv`,
        Buffer.from(csvs[type]),
        'text/csv',
      );
      expect(uploaded.statusCode, uploaded.body).toBe(201);
      expect(uploaded.body).not.toContain('PRIVATE-CSV-KEY');
      const [{ id }] = uploaded.json().payload;
      const { payload } = await ok('GET', `/imports/${id}?import_type=${type}`, 'root');
      const input = { import_type: type, field_map: payload.suggested_map };
      await Promise.all([
        ok('POST', `/imports/process/${id}`, 'root', input),
        ok('POST', `/imports/process/${id}`, 'root', input),
      ]);
      await app.get(ImportsController).processOne();
      const { run } = await ok('GET', `/imports/${id}/progress`, 'root');
      expect(run, `Import ${type}`).toMatchObject({
        state: 'complete',
        processed: 1,
        created: 1,
        errored: 0,
      });
      const next = await multipart(
        '/imports',
        'root',
        `${type}-update.csv`,
        Buffer.from(csvs[type]),
        'text/csv',
      );
      const [{ id: updateId }] = next.json().payload;
      await ok('POST', `/imports/process/${updateId}`, 'root', { ...input, update_existing: true });
      await app.get(ImportsController).processOne();
      const updated = (await ok('GET', `/imports/${updateId}/progress`, 'root')).run;
      expect(updated, `Update ${type}`).toMatchObject({
        state: 'complete',
        processed: 1,
        updated: type === 'assetHistory' ? 0 : 1,
        skipped: type === 'assetHistory' ? 1 : 0,
        errored: 0,
      });
    }
    const asset = await ok('GET', '/hardware/bytag/CSV-ASSET', 'root');
    expect(asset.assigned_to).toBeNull();
    expect(
      (await ok('GET', `/hardware/${asset.id}/history`, 'root')).rows.map(
        (row: Record<string, unknown>) => row.action_type,
      ),
    ).toEqual(expect.arrayContaining(['checkout', 'checkin from']));
    const uploaded = await multipart(
      '/imports',
      'root',
      'mixed.csv',
      Buffer.from('Name,Quantity\nCSV valid,6\nCSV invalid,abc'),
      'text/csv',
    );
    const [{ id }] = uploaded.json().payload;
    await ok('POST', `/imports/process/${id}`, 'root', {
      import_type: 'accessory',
      field_map: { 0: 'name', 1: 'qty' },
    });
    await app.get(ImportsController).processOne();
    const result = await ok('GET', `/imports/${id}/progress`, 'root');
    expect(result.run).toMatchObject({ created: 1, errored: 1, processed: 2 });
    expect(result.rows[0].row_number).toBe(3);
    expect((await ok('GET', '/accessories?search=CSV%20invalid', 'root')).total).toBe(0);
  }, 30_000);

  it('queues scheduled workflows once and applies sign-in-place and company-scoped reminder authorization', async () => {
    await ok('PATCH', '/settings/notifications', 'root', {
      alerts_enabled: true,
      alert_email: 'operations@example.test',
      alert_interval: 30,
      due_checkin_days: 7,
      audit_warning_days: 14,
    });
    expect(
      (
        await http('PATCH', '/settings/notifications', 'root', {
          webhook_selected: 'general',
          webhook_endpoint: 'https://127.0.0.1/hooks',
        })
      ).statusCode,
    ).toBe(422);
    const asset = await create('scheduled-west');
    const checked = await ok('POST', `/hardware/${asset.id}/checkout`, 'root', {
      target_type: 'user',
      target_id: west,
      sign_in_place: true,
      expected_checkin: '2035-05-23',
    });
    const acceptance = checked.payload.acceptance_id;
    const direct = await db
      .select()
      .from(tables.inventoryMailOutbox)
      .where(
        and(
          eq(tables.inventoryMailOutbox.event, 'checkout.asset'),
          sql`${tables.inventoryMailOutbox.subject} like ${'%' + asset.asset_tag}`,
          eq(tables.inventoryMailOutbox.channel, 'email'),
        ),
      );
    expect(direct).toHaveLength(0);
    expect(
      (await http('POST', '/unaccepted-acceptances/send-reminders', 'east', { ids: [acceptance] }))
        .statusCode,
    ).toBe(403);
    const reminder = await ok('POST', '/unaccepted-acceptances/send-reminders', 'west', {
      ids: [acceptance],
    });
    expect(reminder.payload.queued).toBe(1);
    await ok('POST', '/settings/notifications/test', 'root', { email: 'test@example.test' });
    await ok('POST', `/users/${west}/email`, 'root', {});
    const scheduler = app.get(NotificationsController);
    const now = new Date('2035-05-22T14:45:00Z');
    await Promise.all([scheduler.runDue(now), scheduler.runDue(now)]);
    const jobs = await db
      .select()
      .from(tables.scheduledJobRuns)
      .where(eq(tables.scheduledJobRuns.period, '2035-05-22'));
    expect(jobs.map((row) => row.job).sort()).toEqual([
      'expected-checkin',
      'expiring-alerts',
      'inventory-alerts',
      'operational-cleanup',
      'upcoming-audits',
    ]);
    const expected = await db
      .select()
      .from(tables.inventoryMailOutbox)
      .where(
        and(
          eq(tables.inventoryMailOutbox.event, 'expected.user'),
          sql`${tables.inventoryMailOutbox.subject} like ${'%' + asset.asset_tag}`,
        ),
      );
    expect(expected).toHaveLength(1);
  }, 20_000);

  it('includes the full audit count and a queue link when a reminder lists only the oldest audits', async () => {
    const now = new Date();
    await db.insert(tables.assets).values(
      Array.from({ length: 32 }, (_, index) => ({
        assetTag: `audit-overflow-${index}`,
        modelId: model,
        statusId: status,
        nextAuditDate: '2020-01-01',
      })),
    );
    const queue = '/hardware/audit/due-or-overdue';
    const due = await ok('GET', queue + '?search=audit-overflow', 'root');
    expect(due.total).toBe(32);
    await app.get(NotificationsController).runDue(now);
    const [reminder] = await db.select().from(tables.inventoryMailOutbox)
      .where(eq(tables.inventoryMailOutbox.event, 'audit.upcoming'))
      .orderBy(sql`${tables.inventoryMailOutbox.id} desc`)
      .limit(1);
    const allDue = await ok('GET', queue, 'root');
    expect(reminder?.message).toContain(`${allDue.total} asset(s) need an audit. Showing 30.`);
    expect(reminder?.message).toContain(queue);
    expect(reminder?.message).not.toContain('audit-overflow-31');
    expect((await ok('GET', queue + '?search=audit-overflow-31', 'root')).total).toBe(1);
  });

  it('preserves assignment IDs, return permissions, and scoped acquisition counts', async () => {
    const { payload: recipient } = await ok('POST', '/users', 'root', {
      username: 'assignment-parity-recipient',
      activated: true,
      company_ids: [westCompany],
    });
    const accessory = (
      await ok('POST', '/accessories', 'root', {
        name: 'Assignment parity',
        qty: 3,
        company_id: westCompany,
      })
    ).payload;
    const first = (
      await ok('POST', `/accessories/${accessory.id}/checkout`, 'west', {
        target_type: 'user',
        target_id: recipient.id,
        note: 'First assignment',
      })
    ).payload.assignment_ids[0];
    const second = (
      await ok('POST', `/accessories/${accessory.id}/checkout`, 'west', {
        target_type: 'user',
        target_id: recipient.id,
        note: 'Second assignment',
      })
    ).payload.assignment_ids[0];
    expect(first).not.toBe(second);
    expect(
      (await http('POST', `/accessories/${accessory.id}/checkin`, 'west', { assignment_id: first }))
        .statusCode,
    ).toBe(403);
    await ok('POST', `/accessories/${accessory.id}/checkin`, 'root', { assignment_id: first });
    const assignments = await ok('GET', `/accessories/${accessory.id}/checkedout`, 'west');
    expect(assignments.rows).toEqual([
      expect.objectContaining({ id: second, note: 'Second assignment' }),
    ]);
    await ok('POST', `/accessories/${accessory.id}/adjust-quantity`, 'root', {
      amount: 3,
      order_number: 'PARITY-ORDER',
      unit_cost: '1.50',
      note: 'Purchase',
    });
    const orders = `/order-items?item_id=${accessory.id}&item_type=accessory`;
    expect((await ok('GET', orders, 'west')).total).toBe(1);
    expect((await http('GET', orders, 'east')).statusCode).toBe(403);
    expect((await http('GET', '/order-items', 'west')).statusCode).toBe(403);
    const plan = (
      await ok('POST', '/depreciations', 'root', { name: 'Parity depreciation', months: 36 })
    ).payload;
    const deleted = await http('DELETE', `/depreciations/${plan.id}`, 'root');
    expect(deleted.statusCode).toBe(200);
  });

  it('resumes a durable import and applies update-mode adjustments and checkout without replay', async () => {
    const csv = Buffer.from(
      'Name,Quantity,Assigned To\nResumed access,5,west\nUpdated stock,5,west',
    );
    const existing = (
      await ok('POST', '/accessories', 'root', {
        name: 'Updated stock',
        qty: 3,
        notes: 'Keep this note',
        company_id: westCompany,
      })
    ).payload;
    const resumed = (
      await ok('POST', '/accessories', 'root', {
        name: 'Resumed access',
        qty: 5,
        company_id: westCompany,
      })
    ).payload;
    await ok('POST', `/accessories/${resumed.id}/checkout`, 'root', {
      target_type: 'user',
      target_id: west,
    });
    const upload = await multipart('/imports', 'root', 'resume.csv', csv, 'text/csv');
    const [{ id }] = upload.json().payload;
    await db
      .update(tables.users)
      .set({ permissions: sql`${tables.users.permissions} || '{"import":1}'::jsonb` })
      .where(eq(tables.users.id, west));
    expect((await http('GET', `/imports/${id}`, 'west')).statusCode).toBe(404);
    await db
      .update(tables.users)
      .set({ permissions: sql`${tables.users.permissions} - 'import'` })
      .where(eq(tables.users.id, west));
    const run = {
      state: 'running' as const,
      worker: 'terminated-worker',
      actorId: root,
      cursor: 1,
      created: 1,
      updated: 0,
      errored: 0,
      skipped: 0,
      updateExisting: true,
      preserveBlanks: true,
      sendWelcome: false,
    };
    await db
      .update(tables.imports)
      .set({
        run,
        importType: 'accessory',
        fieldMap: { 0: 'name', 1: 'qty', 2: 'assigned_to' },
        processingStartedAt: new Date('2020-01-01T00:00:00Z'),
      })
      .where(eq(tables.imports.id, id));
    await app.get(ImportsController).processOne();
    const result = await ok('GET', `/imports/${id}/progress`, 'root');
    expect(result.run).toMatchObject({
      state: 'complete',
      processed: 2,
      created: 1,
      updated: 1,
      errored: 0,
    });
    expect((await ok('GET', `/accessories/${resumed.id}/checkedout`, 'root')).total).toBe(1);
    expect(await ok('GET', `/accessories/${existing.id}`, 'root')).toMatchObject({
      qty: 5,
      notes: 'Keep this note',
    });
    expect((await ok('GET', `/accessories/${existing.id}/checkedout`, 'root')).total).toBe(1);
    expect(
      await connection`select action_source, quantity from action_logs where item_type='accessory'
      and item_id=${existing.id} and action_type='adjust quantity'`,
    ).toEqual([{ action_source: 'importer', quantity: 2 }]);
  }, 20_000);

  it('queues checkout, check-in, acceptance, request, stock, and expiry behavior through their actual workflows', async () => {
    await ok('PATCH', '/settings/notifications', 'root', {
      alerts_enabled: true,
      alert_email: 'operations@example.test',
      admin_cc_email: 'cc@example.test',
      admin_cc_always: true,
      alert_interval: 30,
      due_checkin_days: 14,
      audit_warning_days: 30,
      webhook_selected: 'general',
      webhook_endpoint: 'https://global.example.test/alerts',
    });
    const asset = (
      await ok('POST', '/hardware', 'root', {
        ...body('notification-parity'),
        asset_eol_date: '2036-01-07',
      })
    ).payload;
    const assigned = (
      await ok('POST', `/hardware/${asset.id}/checkout`, 'root', {
        target_type: 'user',
        target_id: west,
        expected_checkin: '2036-01-03',
      })
    ).payload;
    await ok('POST', `/account/accept/${assigned.acceptance_id}`, 'west', {
      decision: 'decline',
      note: 'Wrong hardware',
    });
    await ok('POST', `/hardware/${asset.id}/audit`, 'root', { next_audit_date: '2036-01-05' });
    for (const [resource, type] of [
      ['licenses', 'license'],
      ['accessories', 'accessory'],
      ['consumables', 'consumable'],
      ['components', 'component'],
    ] as const) {
      const category = (
        await ok('POST', '/categories', 'root', {
          name: `Notification ${type}`,
          category_type: type,
          checkin_email: true,
        })
      ).payload;
      const item = (
        await ok('POST', `/${resource}`, 'root', {
          name: `Lifecycle ${type}`,
          company_id: westCompany,
          category_id: category.id,
          min_amt: 4,
          ...(type === 'license' ? { seats: 2, expiration_date: '2036-01-08' } : { qty: 5 }),
        })
      ).payload;
      const checkout = (
        await ok('POST', `/${resource}/${item.id}/checkout`, 'root', {
          target_type: type === 'component' ? 'asset' : 'user',
          target_id: type === 'component' ? asset.id : west,
        })
      ).payload;
      const assignment = checkout.assignment_ids[0];
      if (type === 'license')
        await ok('POST', `/licenses/${item.id}/checkin`, 'root', { seat_id: assignment });
      if (type === 'accessory')
        await ok('POST', `/accessories/${item.id}/checkin`, 'root', { assignment_id: assignment });
      if (type === 'component')
        await ok('POST', `/components/${assignment}/checkin`, 'root', { quantity: 1 });
    }
    await app.get(NotificationsController).runDue(new Date('2036-01-02T12:00:00Z'));
    await ok('POST', `/hardware/${asset.id}/checkin`, 'root', {});
    const request = (await ok('POST', `/account/request/${asset.id}`, 'west', {})).payload;
    await ok('POST', `/account/requests/${request.id}/cancel`, 'west');
    const accepted = (
      await ok('POST', `/hardware/${asset.id}/checkout`, 'root', {
        target_type: 'user',
        target_id: west,
      })
    ).payload;
    await ok('POST', `/account/accept/${accepted.acceptance_id}`, 'west', {
      decision: 'accept',
      signature: signature(),
    });
    await ok('POST', '/users', 'root', {
      username: 'receive-welcome-message',
      email: 'welcome@example.test',
      send_welcome: true,
    });
    const events = new Set(
      (
        await db
          .select({ event: tables.inventoryMailOutbox.event })
          .from(tables.inventoryMailOutbox)
      ).map((row) => row.event),
    );
    expect(
      notificationEvents.filter((event) => event !== 'first-admin' && !events.has(event)),
    ).toEqual([]);
    const checkoutRecipients = await db
      .select({ recipient: tables.inventoryMailOutbox.recipient })
      .from(tables.inventoryMailOutbox)
      .where(
        and(
          eq(tables.inventoryMailOutbox.event, 'checkout.asset'),
          eq(tables.inventoryMailOutbox.channel, 'email'),
          eq(tables.inventoryMailOutbox.subject, `Asset checked out: ${asset.asset_tag}`),
        ),
      );
    expect(checkoutRecipients.map((row) => row.recipient)).toEqual(
      expect.arrayContaining(['west@example.test', 'cc@example.test']),
    );
  }, 20_000);

  it('delivers through fake SMTP and all webhook transports with company override precedence', async () => {
    const outbound = app.get(InventoryMailService);
    const transport = (
      outbound as unknown as { transport: { sendMail: (data: unknown) => Promise<unknown> } }
    ).transport;
    const smtpSend = vi.spyOn(transport, 'sendMail').mockResolvedValue({});
    const webhookSend = vi.spyOn(webhookDelivery, 'postWebhook').mockResolvedValue();
    try {
      const [email] = await db
        .insert(tables.inventoryMailOutbox)
        .values({
          recipient: 'delivery@example.test',
          event: 'mail-test',
          subject: 'SMTP delivery fixture',
          message: 'Delivery test',
          availableAt: new Date('2010-01-01'),
        })
        .returning();
      await outbound.deliverOne();
      expect(smtpSend).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'delivery@example.test', subject: 'SMTP delivery fixture' }),
      );
      expect(
        (
          await db
            .select()
            .from(tables.inventoryMailOutbox)
            .where(eq(tables.inventoryMailOutbox.id, email!.id))
        )[0]?.sentAt,
      ).toBeInstanceOf(Date);
      for (const provider of ['slack', 'microsoft', 'google', 'general'] as const) {
        const endpoint = `https://company.example.test/${provider}`;
        await ok('PATCH', `/companies/${westCompany}`, 'root', {
          webhook_selected: provider,
          webhook_endpoint: endpoint,
        });
        const [job] = await db
          .insert(tables.inventoryMailOutbox)
          .values({
            recipient: '',
            companyId: westCompany,
            channel: 'webhook',
            event: 'checkout.asset',
            subject: 'Webhook delivery fixture',
            message: 'Delivery test',
            availableAt: new Date('2010-01-01'),
          })
          .returning();
        await outbound.deliverOne();
        expect(webhookSend).toHaveBeenLastCalledWith(
          endpoint,
          expect.any(Object),
          `inventory-${job!.id}`,
        );
      }
      const companyPath = `/companies/${eastCompany}`;
      expect((await http('PATCH', companyPath, 'root', {
        webhook_endpoint: 'https://company.example.test/missing-provider',
      })).statusCode).toBe(422);
      expect((await http('PATCH', `/companies/${westCompany}`, 'root', {
        webhook_selected: null,
      })).statusCode).toBe(422);
      await db.update(tables.companies)
        .set({ webhookEndpoint: 'https://company.example.test/legacy', webhookSelected: null })
        .where(eq(tables.companies.id, eastCompany));
      const enqueueWebhook = async (attempts = 0) => (await db.insert(tables.inventoryMailOutbox).values({
        recipient: '', channel: 'webhook', companyId: eastCompany, attempts,
        subject: 'Incomplete webhook fixture', message: 'Delivery test', availableAt: new Date('2010-01-01'),
      }).returning())[0]!;
      const fallback = await enqueueWebhook();
      await outbound.deliverOne();
      expect(webhookSend).toHaveBeenLastCalledWith(
        'https://global.example.test/alerts', expect.any(Object), `inventory-${fallback.id}`,
      );
      await ok('PATCH', '/settings/notifications', 'root', { webhook_endpoint: null, webhook_selected: null });
      const missing = await enqueueWebhook(7);
      const calls = webhookSend.mock.calls.length;
      await outbound.deliverOne();
      const [failed] = await db.select().from(tables.inventoryMailOutbox)
        .where(eq(tables.inventoryMailOutbox.id, missing.id));
      expect(failed).toMatchObject({ sentAt: null, failedAt: expect.any(Date), attempts: 8 });
      expect(webhookSend).toHaveBeenCalledTimes(calls);
      await ok('PATCH', companyPath, 'root', { webhook_endpoint: null });
    } finally {
      smtpSend.mockRestore();
      webhookSend.mockRestore();
    }
  });

  it('preserves queued SMTP mail when upgrading from populated Phase 3.2', async () => {
    const name = databaseName + '_phase32';
    await cluster`create database ${cluster(name)}`;
    const source = postgres(databaseUrl(name), { max: 1 });
    const folder = await mkdtemp(join(tmpdir(), 'kestrel-phase32-migrations-'));
    try {
      await cp(migrations, folder, { recursive: true });
      const journalPath = join(folder, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 5);
      await writeFile(journalPath, JSON.stringify(journal));
      await migrate(drizzle(source), { migrationsFolder: folder });
      await source`insert into inventory_mail_outbox (recipient,subject,message,attempts) values ('user@example.test','Pending checkout','Pending details',2)`;
      await source`insert into report_templates (name) values ('Existing template')`;
      await migrate(drizzle(source), { migrationsFolder: migrations });
      expect(
        await source`select channel,attempts,subject,sent_at from inventory_mail_outbox`,
      ).toEqual([{ channel: 'email', attempts: 2, subject: 'Pending checkout', sent_at: null }]);
      expect(await source`select is_shared from report_templates`).toEqual([{ is_shared: false }]);
    } finally {
      await source.end();
      await cluster`drop database if exists ${cluster(name)} with (force)`;
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('backfills calendar dates from a populated Phase 2 database', async () => {
    const name = databaseName + '_phase2';
    await cluster`create database ${cluster(name)}`;
    const source = postgres(databaseUrl(name), { max: 1 });
    const folder = await mkdtemp(join(tmpdir(), 'kestrel-phase2-migrations-'));
    try {
      await cp(migrations, folder, { recursive: true });
      const journalPath = join(folder, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 4);
      await writeFile(journalPath, JSON.stringify(journal));
      await migrate(drizzle(source), { migrationsFolder: folder });
      await source`insert into assets (asset_tag, next_audit_date, order_number, purchase_cost) values ('PHASE-2', '2030-05-01', 'LEGACY-PO', 24.50)`;
      await source`insert into licenses (name, expiration_date) values ('Legacy', '2030-07-01')`;
      await migrate(drizzle(source), { migrationsFolder: migrations });
      expect(await source`select event_type from calendar_events order by event_type`).toEqual([
        { event_type: 'asset.audit_due' },
        { event_type: 'license.expiration' },
      ]);
      expect(await source`select id from maintenance_types`).toHaveLength(8);
      expect(
        await source`select order_number, unit_cost, quantity from order_items join orders on orders.id = order_id`,
      ).toEqual([{ order_number: 'LEGACY-PO', unit_cost: '24.50', quantity: 1 }]);
    } finally {
      await source.end();
      await cluster`drop database if exists ${cluster(name)} with (force)`;
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('enforces FMCS, sub-permissions, and Plan 3.5 parity routes across settings, profile, and requestables', async () => {
    const westHost = await create('HOST-P35');
    const eastHost = await create('EAST-HOST-P35', eastCompany);

    const westLicense = (
      await ok('POST', '/licenses', 'root', {
        name: 'West IDE License',
        serial: 'SECRET-KEY-P35',
        seats: 2,
        company_id: westCompany,
        requestable: true,
      })
    ).payload;
    const eastLicense = (
      await ok('POST', '/licenses', 'root', {
        name: 'East IDE License',
        serial: 'EAST-KEY-P35',
        seats: 2,
        company_id: eastCompany,
        requestable: true,
      })
    ).payload;
    const westAccessory = (
      await ok('POST', '/accessories', 'root', {
        name: 'West Dock',
        qty: 3,
        company_id: westCompany,
        requestable: true,
      })
    ).payload;
    const westComponent = (
      await ok('POST', '/components', 'root', {
        name: 'West NVMe 1TB',
        qty: 2,
        serial: 'NVME-P35',
        company_id: westCompany,
        requestable: true,
      })
    ).payload;

    const freeSeat = (await ok('GET', `/licenses/${westLicense.id}/seats`, 'root')).rows.find(
      (s: { assigned_to: number | null }) => s.assigned_to === null,
    );
    await ok('POST', `/licenses/${westLicense.id}/checkout`, 'root', {
      target_type: 'asset',
      target_id: westHost.id,
      seat_id: freeSeat.id,
    });
    await ok('POST', `/accessories/${westAccessory.id}/checkout`, 'root', {
      target_type: 'user',
      target_id: west,
    });
    await ok('POST', `/components/${westComponent.id}/checkout`, 'root', {
      target_type: 'asset',
      target_id: westHost.id,
      assigned_qty: 1,
    });

    const westLicensesTab = await ok('GET', `/hardware/${westHost.id}/licenses`, 'west');
    expect(westLicensesTab.rows[0]).toMatchObject({
      name: 'West IDE License',
      serial: '***************',
    });
    const rootLicensesTab = await ok('GET', `/hardware/${westHost.id}/licenses`, 'root');
    expect(rootLicensesTab.rows[0].serial).toBe('SECRET-KEY-P35');

    // west lacks components.view -> suppressed empty rows instead of leaking components
    const westCompTab = await ok('GET', `/hardware/${westHost.id}/assigned/components`, 'west');
    expect(westCompTab.rows).toEqual([]);
    const rootCompTab = await ok('GET', `/hardware/${westHost.id}/assigned/components`, 'root');
    expect(rootCompTab.rows.map((r: { name: string }) => r.name)).toContain('West NVMe 1TB');

    // Self-service requestable secondary items + FMCS + bulk delete guard + fulfillment
    const westAccCatalog = await ok('GET', '/account/requestable/accessories', 'west');
    expect(westAccCatalog.rows.map((r: { id: number }) => r.id)).toContain(westAccessory.id);
    const westLicCatalog = await ok('GET', '/account/requestable/licenses', 'west');
    expect(westLicCatalog.rows.map((r: { id: number }) => r.id)).not.toContain(eastLicense.id);

    expect(
      (await http('POST', `/account/request/licenses/${eastLicense.id}`, 'west', {})).statusCode,
    ).toBe(404);

    const accReq = (
      await ok('POST', `/account/request/accessories/${westAccessory.id}`, 'west', {
        quantity: 1,
        notes: 'Need spare dock',
      })
    ).payload;
    expect(
      (await http('PATCH', '/accessories/bulk', 'root', { action: 'delete', ids: [westAccessory.id] }))
        .statusCode,
    ).toBe(422);
    expect((await http('POST', `/requests/${accReq.id}/fulfill`, 'east', {})).statusCode).toBe(403);
    await ok('POST', `/requests/${accReq.id}/fulfill`, 'root', { note: 'Approved dock' });

    const compReq = (
      await ok('POST', `/account/request/components/${westComponent.id}`, 'west', { quantity: 1 })
    ).payload;
    expect((await http('POST', `/requests/${compReq.id}/fulfill`, 'root', {})).statusCode).toBe(422);
    await ok('POST', `/requests/${compReq.id}/fulfill`, 'root', { asset_id: westHost.id });

    const licReq = (await ok('POST', `/account/request/licenses/${westLicense.id}`, 'west', {}))
      .payload;
    expect((await http('POST', `/requests/${licReq.id}/cancel`, 'west', {})).statusCode).toBe(403);
    await ok('POST', `/account/requests/${licReq.id}/cancel`, 'west', {});

    // Account, user, location, statuslabel, and dashboard parity views
    const acct = (await ok('GET', '/account/assets', 'west')).payload;
    expect(acct.accessories.map((a: { id: number }) => a.id)).toContain(westAccessory.id);
    expect(
      (await ok('GET', `/users/${west}/accessories`, 'west')).rows.map(
        (a: { id: number }) => a.id,
      ),
    ).toContain(westAccessory.id);
    expect((await http('GET', `/users/${east}/assets`, 'west')).statusCode).toBe(404);
    expect(
      (await ok('GET', `/locations/${westLocation}/assets`, 'west')).rows.map(
        (a: { id: number }) => a.id,
      ),
    ).toContain(westHost.id);
    expect(
      (await ok('GET', `/locations/${westLocation}/assigned/components`, 'root')).rows.map(
        (c: { id: number }) => c.id,
      ),
    ).toContain(westComponent.id);
    expect((await http('GET', `/locations/${eastLocation}/assets`, 'west')).statusCode).toBe(404);

    expect((await http('GET', '/statuslabels/assets/type', 'west')).statusCode).toBe(403);
    const statusByType = (await ok('GET', '/statuslabels/assets/type', 'root')).payload;
    expect(statusByType.deployable).toBeGreaterThanOrEqual(1);
    expect((await ok('GET', `/statuslabels/${status}/deployable`, 'root')).payload.status_type).toBe(
      'deployable',
    );
    const dashSummary = (await ok('GET', '/dashboard/summary', 'west')).payload;
    expect(dashSummary.assets_total).toBeGreaterThanOrEqual(1);
    expect((await ok('GET', '/dashboard/categories', 'west')).payload.length).toBeGreaterThanOrEqual(1);

    // Superuser settings + sanitized secret handling + profile edit
    expect((await http('GET', '/settings', 'west')).statusCode).toBe(403);
    expect((await http('GET', '/settings/login-attempts', 'west')).statusCode).toBe(403);
    const updatedSettings = (
      await ok('PATCH', '/settings', 'root', {
        site_name: 'Kestrel P35',
        oidc_enabled: true,
        oidc_client_secret: 'secret-oidc-value',
      })
    ).payload;
    expect(updatedSettings.site_name).toBe('Kestrel P35');
    expect(updatedSettings.oidc_client_secret_configured).toBe(true);
    expect(JSON.stringify(updatedSettings)).not.toContain('secret-oidc-value');

    expect((await ok('GET', '/settings/login-attempts', 'root')).total).toBeGreaterThanOrEqual(0);
    const westProfile = (
      await ok('PATCH', '/account/profile', 'west', {
        phone: '+39 02 123456',
        locale: 'it-IT',
      })
    ).payload;
    expect(westProfile.phone).toBe('+39 02 123456');
    expect(westProfile.locale).toBe('it-IT');
    expect(eastHost.id).toBeGreaterThan(0);
  });
  it('counts only actionable checkout requests for a scoped secondary-inventory operator', async () => {
    const [operator] = await db.insert(tables.users).values({
      username: 'component-operator',
      activated: true,
      permissions: { 'components.checkout': 1 },
    }).returning({ id: tables.users.id });
    await db.insert(tables.companyUser).values([
      { userId: operator!.id, companyId: westCompany },
      { userId: west, companyId: westCompany },
    ]);
    tokens.set('componentOperator', await app.get(JwtService).signAccessToken({
      userId: operator!.id,
      username: 'component-operator',
      twoFactorVerified: true,
    }));

    const component = async (name: string, companyId: number) =>
      (await ok('POST', '/components', 'root', {
        name, qty: 2, company_id: companyId, requestable: true,
      })).payload;
    const inScope = await component('West operator component', westCompany);
    const outOfScope = await component('East operator component', eastCompany);
    const inScopeRequest = (await ok('POST', `/account/request/components/${inScope.id}`, 'west', {})).payload;
    const outOfScopeRequest = (await ok('POST', `/account/request/components/${outOfScope.id}`, 'east', {})).payload;
    const accessory = (await ok('POST', '/accessories', 'root', {
      name: 'West operator accessory', qty: 2, company_id: westCompany, requestable: true,
    })).payload;
    const otherKind = (await ok('POST', `/account/request/accessories/${accessory.id}`, 'west', {})).payload;

    const queue = await ok('GET', '/requests', 'componentOperator');
    expect(queue.rows.map(({ id }: { id: number }) => id)).toEqual([inScopeRequest.id]);
    expect((await ok('GET', '/dashboard/summary', 'componentOperator')).payload.pending_checkout_requests)
      .toBe(queue.total);
    expect((await ok('GET', '/dashboard/summary', 'east')).payload.pending_checkout_requests).toBe(0);
    expect((await http('GET', '/requests', 'east')).statusCode).toBe(403);
    expect((await ok('GET', '/requests', 'west')).rows.map(({ id }: { id: number }) => id))
      .toContain(otherKind.id);
    expect((await http('GET', '/hardware/targets/asset', 'componentOperator')).statusCode).toBe(403);
    expect((await ok('GET', '/components/targets/asset', 'componentOperator')).results).toBeInstanceOf(
      Array,
    );

    await ok('POST', `/account/requests/${inScopeRequest.id}/cancel`, 'west', {});
    expect((await ok('GET', '/dashboard/summary', 'componentOperator')).payload.pending_checkout_requests)
      .toBe(0);
    await ok('POST', `/account/requests/${outOfScopeRequest.id}/cancel`, 'east', {});
    await ok('POST', `/account/requests/${otherKind.id}/cancel`, 'west', {});
    await db.delete(tables.companyUser).where(and(
      eq(tables.companyUser.userId, west),
      eq(tables.companyUser.companyId, westCompany),
    ));
  });

  it('keeps assigned inventory arrays and reports totals across pages', async () => {
    const assignments = Array.from({ length: 51 }, (_, index) => ({
      assetTag: 'SELF-' + String(index).padStart(2, '0'),
      name: 'Self-service page fixture',
      companyId: westCompany,
      assignedType: 'user' as const,
      assignedTo: west,
    }));
    await db.insert(tables.assets).values(assignments);
    try {
      const first = (await ok('GET', '/account/assets', 'west')).payload;
      const second = (await ok('GET', '/account/assets?page=2', 'west')).payload;
      expect(first.assets).toHaveLength(50);
      expect(second.assets.length).toBeGreaterThan(0);
      expect(first.pagination).toMatchObject({
        current_page: 1,
        total_pages: 2,
        totals: { assets: first.assets.length + second.assets.length },
      });
      expect(second.pagination).toMatchObject({ current_page: 2, totals: first.pagination.totals });
      expect(first.assets.some(({ id }: { id: number }) =>
        second.assets.some((asset: { id: number }) => asset.id === id),
      )).toBe(false);
      expect(Array.isArray(second.accessories)).toBe(true);
      expect(Array.isArray(second.consumables)).toBe(true);
      expect(Array.isArray(second.licenses)).toBe(true);
    } finally {
      await db.delete(tables.assets).where(inArray(tables.assets.assetTag, assignments.map(({ assetTag }) => assetTag)));
    }
  });

  it('exposes only the sign-in notice publicly and enforces local password and profile policy', async () => {
    const [linkedUser] = await db.insert(tables.users).values({
      username: 'linked-user',
      activated: true,
      remote: true,
      oidcIssuer: 'https://idp.example.test',
      oidcSubject: 'linked-subject',
    }).returning({ id: tables.users.id });
    tokens.set('linkedUser', await app.get(JwtService).signAccessToken({
      userId: linkedUser!.id,
      username: 'linked-user',
      twoFactorVerified: true,
    }));
    const initialPassword = 'Existing local password 2026';
    const changedPassword = 'New local password 2026';

    await ok('PATCH', '/settings', 'root', {
      dashboard_message: 'Inventory dashboard notice',
      login_note: 'Sign-in information',
      oidc_client_secret: 'admin-only-secret',
    });
    const providers = await app.inject({ method: 'GET', url: '/api/v1/auth/providers' });
    expect(providers.statusCode).toBe(200);
    expect(providers.json()).toMatchObject({ loginNote: 'Sign-in information' });
    expect(providers.body).not.toContain('Inventory dashboard notice');
    expect(providers.body).not.toContain('admin-only-secret');
    expect((await app.inject({ method: 'GET', url: '/api/v1/dashboard/summary' })).statusCode).toBe(401);
    expect((await ok('GET', '/dashboard/summary', 'linkedUser')).payload.dashboard_message)
      .toBe('Inventory dashboard notice');

    const change = { current_password: initialPassword, new_password: changedPassword };
    expect((await http('PATCH', '/account/profile', 'linkedUser', change)).statusCode).toBe(403);
    expect((await ok('PATCH', '/account/profile', 'linkedUser', { phone: '555-0100' })).payload)
      .toMatchObject({ has_local_password: false, phone: '555-0100' });

    const crypto = app.get(CryptoService);
    await db.update(tables.users)
      .set({ password: crypto.hashPassword(initialPassword) })
      .where(eq(tables.users.id, linkedUser!.id));
    try {
      await ok('PATCH', '/settings', 'root', { profile_edit: false });
      expect((await http('PATCH', '/account/profile', 'linkedUser', change)).statusCode).toBe(403);
      await ok('PATCH', '/settings', 'root', { profile_edit: true });
      expect((await http('PATCH', '/account/profile', 'linkedUser', {
        ...change, current_password: 'Wrong current password',
      })).statusCode).toBe(422);
      await ok('PATCH', '/account/profile', 'linkedUser', change);
      const [account] = await db.select({ password: tables.users.password })
        .from(tables.users).where(eq(tables.users.id, linkedUser!.id));
      expect(await crypto.verifyPassword(changedPassword, account!.password!)).toBe(true);
    } finally {
      await ok('PATCH', '/settings', 'root', {
        profile_edit: true, dashboard_message: null, login_note: null, oidc_client_secret: null,
      });
    }
  });

  async function fixtureActor(actor: Token, permissions: PermissionMap, companyId = westCompany) {
    const [row] = await db.insert(tables.users).values({
      username: actor,
      activated: true,
      permissions,
    }).returning({ id: tables.users.id });
    await db.insert(tables.companyUser).values({ userId: row!.id, companyId });
    tokens.set(actor, await app.get(JwtService).signAccessToken({
      userId: row!.id,
      username: actor,
      twoFactorVerified: true,
    }));
    return row!.id;
  }

  it('uses the assigned fieldset for asset subresources even when its ID matches a different model', async () => {
    const [original] = await db.select({ categoryId: tables.models.categoryId })
      .from(tables.models).where(eq(tables.models.id, model));
    const expectedFieldset = 100_001;
    const expectedModel = 100_002;
    await db.insert(tables.customFieldsets).values({ id: expectedFieldset, name: 'Subresource fields' });
    const joins = await db.select().from(tables.customFieldCustomFieldset)
      .where(eq(tables.customFieldCustomFieldset.customFieldsetId, fieldset));
    await db.insert(tables.customFieldCustomFieldset).values(joins.map((join) => ({
      customFieldsetId: expectedFieldset,
      customFieldId: join.customFieldId,
      order: join.order,
      required: join.required,
    })));
    await db.insert(tables.models).values([
      { id: expectedModel, name: 'Subresource model', fieldsetId: expectedFieldset, categoryId: original!.categoryId },
      { id: expectedFieldset, name: 'Collision model without fields' },
    ]);

    const asset = (await ok('POST', '/hardware', 'root', {
      ...body('SUBRESOURCE-CUSTOM'),
      model_id: expectedModel,
    })).payload;
    await db.update(tables.assets)
      .set({ assignedTo: west, assignedType: 'user', locationId: westLocation })
      .where(eq(tables.assets.id, asset.id));
    const match = (item: { id: number }) => item.id === asset.id;
    const detail = await ok('GET', `/hardware/${asset.id}`, 'west');
    expect(detail.custom_fields['Confidential ID'].value).toBe('ENCRYPTED');
    expect(Object.values(detail.custom_fields)).toContainEqual(expect.objectContaining({ value: 'Blue' }));

    const assigned = (await ok('GET', `/users/${west}/assets?limit=500`, 'west')).rows.find(match);
    const account = (await ok('GET', '/account/assets?limit=500', 'west')).payload.assets.find(match);
    const location = (await ok('GET', `/locations/${westLocation}/assets?limit=500`, 'west')).rows.find(match);
    for (const row of [assigned, account, location]) {
      expect(row?.custom_fields).toEqual(detail.custom_fields);
    }
    const rootLocation = (await ok('GET', `/locations/${westLocation}/assets?limit=500`, 'root')).rows.find(match);
    expect(rootLocation.custom_fields['Confidential ID'].value).toBe('key-SUBRESOURCE-CUSTOM');
  });

  it('applies record permissions and company scope to history and assignment references', async () => {
    const reader = await fixtureActor('limitedReader', {
      'locations.view': 1,
      'users.view': 1,
      'components.view': 1,
      'licenses.view': 1,
    });
    const host = await create('HISTORY-WEST');
    const eastHost = await create('HISTORY-EAST', eastCompany);
    const [component] = await db.insert(tables.components).values({
      name: 'Visibility fixture', companyId: westCompany, qty: 1,
    }).returning({ id: tables.components.id });
    await db.insert(tables.componentsAssets).values({ componentId: component!.id, assetId: host.id });
    const path = `/locations/${westLocation}/assigned/components?limit=500`;
    const findComponent = ({ id }: { id: number }) => id === component!.id;
    const limited = (await ok('GET', path, 'limitedReader')).rows.find(findComponent);
    expect(limited).toMatchObject({ asset_id: null, asset_tag: null, assigned_qty: 1 });
    const allowed = (await ok('GET', path, 'root')).rows.find(findComponent);
    expect(allowed).toMatchObject({ asset_id: host.id, asset_tag: host.asset_tag });

    const [license] = await db.insert(tables.licenses).values({
      name: 'West visibility license', companyId: westCompany, seats: 3,
    }).returning({ id: tables.licenses.id });
    const [otherLicense] = await db.insert(tables.licenses).values({
      name: 'East visibility license', companyId: eastCompany, seats: 1,
    }).returning({ id: tables.licenses.id });
    const [deleted] = await db.insert(tables.users).values({
      username: 'deleted-seat-assignee', deletedAt: new Date(),
    }).returning({ id: tables.users.id });
    const [localSeat, crossCompanySeat, deletedSeat, otherSeat] = await db.insert(tables.licenseSeats)
      .values([
        { licenseId: license!.id, assetId: host.id, assignedTo: reader },
        { licenseId: license!.id, assetId: host.id, assignedTo: east },
        { licenseId: license!.id, assetId: host.id, assignedTo: deleted!.id },
        { licenseId: otherLicense!.id },
      ]).returning({ id: tables.licenseSeats.id });
    const seatsPath = `/hardware/${host.id}/licenses`;
    const seats = (await ok('GET', seatsPath, 'west')).rows;
    expect(seats).toEqual(expect.arrayContaining([
      expect.objectContaining({ seat_id: localSeat!.id, assigned_to: reader }),
      expect.objectContaining({ seat_id: crossCompanySeat!.id, assigned_to: null }),
      expect.objectContaining({ seat_id: deletedSeat!.id, assigned_to: null }),
    ]));
    const rootSeats = (await ok('GET', seatsPath, 'root')).rows;
    expect(rootSeats).toContainEqual(expect.objectContaining({ seat_id: crossCompanySeat!.id, assigned_to: east }));

    const [westRepair, eastRepair] = await db.insert(tables.assetMaintenances).values([
      { itemId: host.id, name: 'West repair', startDate: '2030-01-01', assetMaintenanceType: 'Repair' },
      { itemId: eastHost.id, name: 'East repair', startDate: '2030-01-01', assetMaintenanceType: 'Repair' },
    ]).returning({ id: tables.assetMaintenances.id });
    await db.insert(tables.actionLogs).values([
      { itemType: 'user', itemId: reader, note: 'user', targetType: 'asset', targetId: eastHost.id },
      { itemType: 'asset', itemId: host.id, note: 'asset' },
      { itemType: 'asset', itemId: eastHost.id, note: 'other asset' },
      { itemType: 'maintenance', itemId: westRepair!.id, note: 'maintenance' },
      { itemType: 'maintenance', itemId: eastRepair!.id, note: 'other maintenance' },
      { itemType: 'license_seat', itemId: localSeat!.id, note: 'seat' },
      { itemType: 'license_seat', itemId: otherSeat!.id, note: 'other seat' },
      { itemType: 'setting', itemId: 1, note: 'setting' },
    ].map((entry) => ({
      ...entry, createdBy: reader, actionType: 'update', companyId: westCompany,
    })));
    const historyPath = `/users/${reader}/history`;
    const notes = (rows: { note: string }[]) => rows.map(({ note }) => note).sort();
    const restricted = await ok('GET', historyPath, 'limitedReader');
    expect(restricted.total).toBe(2);
    expect(notes(restricted.rows)).toEqual(['seat', 'user']);
    expect(restricted.rows.find(({ note }: { note: string }) => note === 'user').target_id).toBeNull();
    const firstPage = await ok('GET', historyPath + '?limit=1', 'limitedReader');
    expect(firstPage).toMatchObject({ total: 2, total_pages: 2 });
    expect(firstPage.rows).toHaveLength(1);
    const scoped = await ok('GET', historyPath, 'west');
    expect(notes(scoped.rows)).toEqual(['asset', 'maintenance', 'seat', 'user']);
    expect((await ok('GET', historyPath, 'root')).total).toBe(8);
  });

  it('aggregates both status endpoints with identical classification and company scope', async () => {
    await fixtureActor('statusReader', { 'assets.view': 1, 'statuslabels.view': 1 });
    const empty = { deployable: 0, deployed: 0, archived: 0, pending: 0, undeployable: 0 };
    const dashboard = async (actor: Token) => (await ok('GET', '/dashboard/summary', actor)).payload;
    const beforeWest = await dashboard('statusReader');
    const beforeRoot = await dashboard('root');
    const [ready, pending, archived, undeployable, removed] = await db.insert(tables.statusLabels).values([
      { name: 'Aggregate ready', deployable: true },
      { name: 'Aggregate pending', deployable: true, pending: true },
      { name: 'Aggregate archived', deployable: true, pending: true, archived: true },
      { name: 'Aggregate undeployable' },
      { name: 'Aggregate deleted', deployable: true, deletedAt: new Date() },
    ]).returning({ id: tables.statusLabels.id });
    const rows: (typeof tables.assets.$inferInsert)[] = [
      { assetTag: 'COUNT-READY', statusId: ready!.id },
      { assetTag: 'COUNT-DEPLOYED', statusId: ready!.id, assignedTo: west, assignedType: 'user' },
      { assetTag: 'COUNT-PENDING', statusId: pending!.id, assignedTo: west, assignedType: 'user' },
      { assetTag: 'COUNT-ARCHIVED-LABEL', statusId: archived!.id },
      { assetTag: 'COUNT-ARCHIVED-ASSET', statusId: pending!.id, archived: true },
      { assetTag: 'COUNT-UNDEPLOYABLE', statusId: undeployable!.id },
      { assetTag: 'COUNT-DELETED-LABEL', statusId: removed!.id },
      { assetTag: 'COUNT-MISSING-LABEL' },
      { assetTag: 'COUNT-DELETED-ASSET', statusId: ready!.id, deletedAt: new Date() },
    ];
    await db.insert(tables.assets).values([
      ...rows.map((row) => ({ ...row, companyId: westCompany, customFields: { unused: 'fixture' } })),
      { assetTag: 'COUNT-OTHER-COMPANY', companyId: eastCompany, statusId: ready!.id },
    ]);

    const afterWest = await dashboard('statusReader');
    const afterRoot = await dashboard('root');
    const delta = (before: Record<string, number>, after: Record<string, number>) =>
      Object.fromEntries(Object.keys(empty).map((key) => [key, after[key]! - before[key]!]));
    const expected = { deployable: 1, deployed: 1, archived: 2, pending: 1, undeployable: 3 };
    expect(delta(beforeWest.status_breakdown, afterWest.status_breakdown)).toEqual(expected);
    expect(delta(beforeRoot.status_breakdown, afterRoot.status_breakdown)).toEqual({ ...expected, deployable: 2 });
    expect(afterWest.assets_total - beforeWest.assets_total).toBe(8);
    expect(afterRoot.assets_total - beforeRoot.assets_total).toBe(9);
    await fixtureActor('noAssetReader', {});
    expect((await dashboard('noAssetReader')).status_breakdown).toEqual(empty);

    const selections = vi.spyOn(app.get<DrizzleDb>(DRIZZLE_DB), 'select');
    try {
      const counts = (await ok('GET', '/statuslabels/assets/type', 'statusReader')).payload;
      expect(counts).toEqual(afterWest.status_breakdown);
      expect(selections.mock.calls.map(([fields]) => Object.keys(fields ?? {})))
        .toContainEqual(['archived', 'assigned', 'status', 'total']);
      expect(selections.mock.calls.some(([fields]) => fields && 'asset' in fields)).toBe(false);
    } finally {
      selections.mockRestore();
    }
  });

  it('allows one concurrent email update and refuses ambiguous federated links on historical duplicates', async () => {
    const first = await fixtureActor('firstEmailWriter', {});
    const second = await fixtureActor('secondEmailWriter', {});
    const email = 'shared-followup@example.test';
    const results = await Promise.all([
      http('PATCH', '/account/profile', 'firstEmailWriter', { email }),
      http('PATCH', '/account/profile', 'secondEmailWriter', { email: email.toUpperCase() }),
    ]);
    expect(results.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
    const winner = results.find(({ statusCode }) => statusCode === 200)!.json().payload;
    const loserId = winner.id === first ? second : first;
    const loser = winner.id === first ? 'secondEmailWriter' : 'firstEmailWriter';
    expect(results.find(({ statusCode }) => statusCode === 409)!.json().messages)
      .toHaveProperty('email');

    const [config] = await db.select().from(tables.settings).orderBy(tables.settings.id).limit(1);
    await db.update(tables.settings)
      .set({ oidcLinkExistingUsers: true, oidcAutoProvisionUsers: true, oidcSyncOnLogin: false })
      .where(eq(tables.settings.id, config!.id));
    try {
      const provisioning = app.get(OidcUserProvisioningService);
      const claims = {
        iss: 'https://phase35-idp.example.test',
        sub: 'unique-email-subject',
        preferred_username: 'unused-federated-username',
        email: winner.email,
        email_verified: true,
      };
      expect((await provisioning.resolveOrProvisionUser(claims)).id).toBe(winner.id);

      await db.update(tables.users).set({ email: winner.email }).where(eq(tables.users.id, loserId));
      expect((await ok('PATCH', '/account/profile', loser, {
        email: winner.email, phone: '+39 555 0142',
      })).payload).toMatchObject({ email: winner.email, phone: '+39 555 0142' });
      await expect(provisioning.resolveOrProvisionUser({ ...claims, sub: 'ambiguous-email-subject' }))
        .rejects.toThrow('OIDC email matches more than one account');
      expect(await db.select({ id: tables.users.id }).from(tables.users)
        .where(eq(tables.users.oidcSubject, 'ambiguous-email-subject'))).toEqual([]);
      expect((await provisioning.resolveOrProvisionUser(claims)).id).toBe(winner.id);
      expect((await ok('PATCH', '/account/profile', loser, { email: null })).payload.email).toBeNull();
    } finally {
      await db.update(tables.settings).set({
        oidcLinkExistingUsers: config!.oidcLinkExistingUsers,
        oidcAutoProvisionUsers: config!.oidcAutoProvisionUsers,
        oidcSyncOnLogin: config!.oidcSyncOnLogin,
      }).where(eq(tables.settings.id, config!.id));
    }
  });

  it('validates settings URLs on write and accepts unrelated edits with legacy URLs stored', async () => {
    const [config] = await db.select().from(tables.settings).orderBy(tables.settings.id).limit(1);
    const legacyUrl = 'ftp://legacy.example.test/privacy';
    await db.update(tables.settings).set({ privacyPolicyLink: legacyUrl })
      .where(eq(tables.settings.id, config!.id));
    try {
      const update = await ok('PATCH', '/settings', 'root', { site_name: 'Settings upgrade fixture' });
      expect(update.payload.privacy_policy_link).toBe(legacyUrl);
      const invalid = await http('PATCH', '/settings', 'root', {
        privacy_policy_link: 'ftp://files.example.test/privacy',
        oidc_issuer_url: 'file:///issuer',
      });
      expect(invalid.statusCode).toBe(422);
      expect(invalid.json().messages).toMatchObject({
        privacy_policy_link: ['Use an HTTP or HTTPS URL'],
        oidc_issuer_url: ['Use an HTTP or HTTPS URL'],
      });
      const valid = await ok('PATCH', '/settings', 'root', {
        privacy_policy_link: 'https://example.test/privacy',
        oidc_issuer_url: 'http://localhost:4100',
      });
      expect(valid.payload).toMatchObject({
        privacy_policy_link: 'https://example.test/privacy',
        oidc_issuer_url: 'http://localhost:4100',
      });
    } finally {
      await db.update(tables.settings).set({
        siteName: config!.siteName,
        privacyPolicyLink: config!.privacyPolicyLink,
        oidcIssuerUrl: config!.oidcIssuerUrl,
      }).where(eq(tables.settings.id, config!.id));
    }
  });

  it('enforces case-insensitive email uniqueness in directory user create, edit, and restore', async () => {
    const email = 'directory-unique@example.test';
    const first = (
      await ok('POST', '/users', 'root', {
        username: 'dir-email-first',
        email,
        activated: true,
      })
    ).payload;
    const dupCreate = await http('POST', '/users', 'root', {
      username: 'dir-email-dup',
      email: email.toUpperCase(),
      activated: true,
    });
    expect(dupCreate.statusCode).toBe(409);
    expect(dupCreate.json().messages).toHaveProperty('email');

    const second = (
      await ok('POST', '/users', 'root', {
        username: 'dir-email-second',
        email: 'directory-second@example.test',
        activated: true,
      })
    ).payload;
    const dupPatch = await http('PATCH', `/users/${second.id}`, 'root', {
      email: `  ${email.toUpperCase()}  `,
    });
    expect(dupPatch.statusCode).toBe(409);
    expect(dupPatch.json().messages).toHaveProperty('email');

    // Unrelated edits keep working when the email is unchanged.
    const unchanged = await ok('PATCH', `/users/${first.id}`, 'root', {
      phone: '+39 555 0199',
    });
    expect(unchanged.payload).toMatchObject({ email, phone: '+39 555 0199' });

    // Soft-deleting first frees the email; reclaiming it blocks restoring first.
    await ok('DELETE', `/users/${first.id}`, 'root');
    await db.update(tables.users).set({ email: `  ${email}  ` }).where(eq(tables.users.id, first.id));
    await ok('PATCH', `/users/${second.id}`, 'root', { email });
    const restoreConflict = await http('POST', `/users/${first.id}/restore`, 'root', {});
    expect(restoreConflict.statusCode).toBe(409);
    expect(restoreConflict.json().messages).toHaveProperty('email');
  });

  it('prunes non-candidate depreciation rows on numeric search while keeping exact book-value matches', async () => {
    const [depSchedule] = await db
      .insert(tables.depreciations)
      .values({ name: 'Numeric Prune 12m', months: 12, depreciationMin: '0.00', depreciationType: 'amount' })
      .returning({ id: tables.depreciations.id });
    const [depModel] = await db
      .insert(tables.models)
      .values({ name: 'Numeric Prune Model', depreciationId: depSchedule!.id })
      .returning({ id: tables.models.id });
    const [noDepModel] = await db
      .insert(tables.models)
      .values({ name: 'Numeric No-Dep Model' })
      .returning({ id: tables.models.id });

    const inserted = await db
      .insert(tables.assets)
      .values([
        {
          assetTag: '887766',
          name: 'High numeric tag asset',
          companyId: westCompany,
          modelId: depModel!.id,
          purchaseCost: '1200.00',
          purchaseDate: '2025-01-01',
        },
        {
          assetTag: 'PRUNE-HALF',
          name: 'Depreciated to 600.00',
          companyId: westCompany,
          modelId: depModel!.id,
          purchaseCost: '1200.00',
          purchaseDate: '2025-01-01',
        },
        {
          assetTag: 'PRUNE-SERIAL',
          serial: 'Serial 887766',
          companyId: westCompany,
          modelId: depModel!.id,
          purchaseCost: '1200.00',
          purchaseDate: '2025-01-01',
        },
        ...['PRUNE-BOOK-A', 'PRUNE-BOOK-B'].map((assetTag) => ({
          assetTag,
          companyId: westCompany,
          modelId: depModel!.id,
          purchaseCost: '1775532.00',
          purchaseDate: '2025-01-01',
        })),
        {
          assetTag: 'PRUNE-CHEAP',
          name: 'Low cost asset',
          companyId: westCompany,
          modelId: depModel!.id,
          purchaseCost: '100.00',
          purchaseDate: '2025-01-01',
        },
        {
          assetTag: 'PRUNE-NODEP',
          name: 'No depreciation asset',
          companyId: westCompany,
          modelId: noDepModel!.id,
          purchaseCost: '1200.00',
          purchaseDate: '2025-01-01',
        },
        {
          assetTag: 'PRUNE-CENTS',
          name: 'Fractional book value',
          companyId: westCompany,
          modelId: depModel!.id,
          purchaseCost: '0.98',
          purchaseDate: '2025-01-01',
        },
      ])
      .returning({ id: tables.assets.id, assetTag: tables.assets.assetTag });

    try {
      const numericSearch = `/reports/depreciation?search=887766&as_of=2025-07-01&model_id=${depModel!.id}`;
      const assetTagOrder = numericSearch + '&sort=asset_tag&order=asc&limit=2';
      const executeSpy = vi.spyOn(app.get<DrizzleDb>(DRIZZLE_DB), 'execute');
      try {
        const tagSearch = await ok('GET', assetTagOrder, 'root');
        expect(tagSearch).toMatchObject({ total: 4, rows: [
          { asset_tag: '887766', book_value: '600.00' },
          { asset_tag: 'PRUNE-BOOK-A', book_value: '887766.00' },
        ] });
        const candidateGroups = await executeSpy.mock.results[0]?.value;
        expect(candidateGroups).toHaveLength(2);
        expect(candidateGroups).toContainEqual(
          expect.objectContaining({ _sql_match: false, ids: expect.arrayContaining(
            inserted.filter(({ assetTag }) => assetTag?.startsWith('PRUNE-BOOK-')).map(({ id }) => id),
          ) }),
        );
      } finally {
        executeSpy.mockRestore();
      }
      expect(await ok('GET', assetTagOrder + '&page=2', 'root')).toMatchObject({ total: 4, rows: [
        { asset_tag: 'PRUNE-BOOK-B', book_value: '887766.00' },
        { asset_tag: 'PRUNE-SERIAL', book_value: '600.00' },
      ] });
      expect(await ok('GET', numericSearch + '&sort=book_value&order=desc&limit=2', 'root'))
        .toMatchObject({ total: 4, rows: [{ asset_tag: 'PRUNE-BOOK-B' }, { asset_tag: 'PRUNE-BOOK-A' }] });
      const csv = await http('GET', numericSearch + '&format=csv&sort=asset_tag&columns=asset_tag', 'root');
      expect(parseCsv(csv.body, { columns: true })).toEqual(
        ['887766', 'PRUNE-BOOK-A', 'PRUNE-BOOK-B', 'PRUNE-SERIAL'].map((asset_tag) => ({ asset_tag })),
      );

      const bookMatch = await ok(
        'GET',
        `/reports/depreciation?search=600.00&as_of=2025-07-01&company_id=${westCompany}`,
        'root',
      );
      expect(bookMatch.rows.map(({ asset_tag }: { asset_tag: string }) => asset_tag)).toEqual(
        expect.arrayContaining(['887766', 'PRUNE-HALF']),
      );
      expect(bookMatch.rows.map(({ asset_tag }: { asset_tag: string }) => asset_tag)).not.toContain(
        'PRUNE-CHEAP',
      );
      expect(bookMatch.rows.map(({ asset_tag }: { asset_tag: string }) => asset_tag)).not.toContain(
        'PRUNE-NODEP',
      );

      for (const search of ['49', '.49']) {
        const centsMatch = await ok(
          'GET',
          `/reports/depreciation?search=${search}&as_of=2025-07-01&company_id=${westCompany}`,
          'root',
        );
        expect(centsMatch.rows).toEqual(
          expect.arrayContaining([expect.objectContaining({ asset_tag: 'PRUNE-CENTS', book_value: '0.49' })]),
        );
      }
    } finally {
      await db.delete(tables.assets).where(inArray(tables.assets.id, inserted.map(({ id }) => id)));
      await db.delete(tables.models).where(inArray(tables.models.id, [depModel!.id, noDepModel!.id]));
      await db.delete(tables.depreciations).where(eq(tables.depreciations.id, depSchedule!.id));
    }
  });
});

describe('Phase 3 depreciation', () => {
  it('caps fixed and percentage floors and respects month and fiscal boundaries', () => {
    const schedule = {
      months: 24,
      depreciationMin: '100',
      depreciationType: 'amount' as const,
      fiscalYearStartMonth: 7,
      rateMultiplier: '2',
    };
    for (const method of ['default', 'half_1', 'half_2', 'diminish'] as const) {
      expect(depreciationValue(schedule, '800', '2020-01-31', method, '2030-01-01')).toBe('100.00');
      expect(
        depreciationValue(
          { ...schedule, depreciationType: 'percent', depreciationMin: '25' },
          '800',
          '2020-01-31',
          method,
          '2030-01-01',
        ),
      ).toBe('200.00');
      expect(
        depreciationValue(
          { ...schedule, depreciationMin: '900' },
          '800',
          '2020-01-31',
          method,
          '2030-01-01',
        ),
      ).toBe('800.00');
    }
    expect(depreciationValue(schedule, '800', '2020-01-31', 'default', '2020-02-01')).toBe(
      '800.00',
    );
    expect(depreciationValue(schedule, '800', '2024-06-30', 'diminish', '2024-07-01')).toBe(
      '795.62',
    );
    expect(depreciationValue(schedule, '800', '2020-01-01', 'half_1', '2020-06-01')).toBe('800.00');
    expect(depreciationValue(schedule, '800', '2020-01-01', 'half_2', '2020-06-01')).toBe('600.00');
  });
});

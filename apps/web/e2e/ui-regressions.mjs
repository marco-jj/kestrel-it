import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';

const {
  KESTREL_E2E_URL: baseURL,
  KESTREL_E2E_USERNAME: username,
  KESTREL_E2E_PASSWORD: password,
  KESTREL_E2E_CHROMIUM: executablePath,
  KESTREL_E2E_REAL_EXPIRY: realExpiry,
} = process.env;

assert(baseURL && username && password, 'Configure the test instance as described in e2e/README.md.');

async function signIn(browser) {
  const page = await browser.newPage({ baseURL });
  page.setDefaultTimeout(10_000);
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.locator('button[type=submit]').click();
  await page.waitForURL('**/dashboard');
  return page;
}

async function create(page, path, data) {
  const response = await page.request.post('/api/v1' + path, { data });
  assert(response.ok(), `POST ${path} returned ${response.status()}`);
  return (await response.json()).payload;
}

async function openCreate(page, path) {
  await page.goto(path);
  await page.getByRole('button', { name: 'New Record' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  return dialog;
}

test('Inventory UI regressions in Chromium', { timeout: 120_000 }, async (t) => {
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());
  const page = await signIn(browser);
  const seed = randomUUID().slice(0, 8);
  const category = await create(page, '/categories', { name: 'UI asset category ' + seed, category_type: 'asset' });
  const model = await create(page, '/models', { name: 'UI model ' + seed, category_id: category.id });
  const status = await create(page, '/statuslabels', { name: 'UI status ' + seed, deployable: true });
  const assetTag = 'UI-TAG-' + seed;
  await create(page, '/hardware', { asset_tag: assetTag, model_id: model.id, status_id: status.id });

  await t.test('clicking outside closes a populated or empty dropdown', async () => {
    const dialog = await openCreate(page, '/hardware');
    const select = dialog.locator('kestrel-async-select').filter({
      has: page.getByText('Model', { exact: true }),
    });
    const input = select.getByRole('combobox');
    const list = select.getByRole('listbox');
    await input.fill(model.name);
    await list.getByRole('option', { name: model.name }).waitFor();
    await dialog.getByText('Serial number', { exact: true }).click();
    await list.waitFor({ state: 'hidden' });
    await input.fill('missing-' + seed);
    await list.getByText('No matching records for active company scope.').waitFor();
    await dialog.getByRole('heading').click();
    await list.waitFor({ state: 'hidden' });
    await input.click();
    await list.waitFor();
    await dialog.getByLabel('Serial number', { exact: true }).focus();
    await list.waitFor({ state: 'hidden' });
  });

  await t.test('license dates use dd/MM/yyyy in the calendar, detail, grid and edit form', async () => {
    const name = 'UI license ' + seed;
    const month = new Date().toISOString().slice(0, 7);
    const iso = (day) => month + '-' + day;
    const display = (day) => iso(day).split('-').reverse().join('/');
    const license = await create(page, '/licenses', {
      name, seats: 1, expiration_date: iso('11'), termination_date: iso('26'), purchase_date: iso('03'),
    });
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: 680, height: 900 });
    try {
      await page.goto('/calendar');
      const agenda = page.getByRole('list', { name: 'Monthly events' });
      const expiry = { name: 'License expiry · ' + name, exact: true };
      const event = agenda.getByRole('listitem').filter({ has: page.getByRole('link', expiry) });
      await event.getByText(display('11'), { exact: true }).waitFor();
      await event.getByRole('link', expiry).click();
      const detail = page.getByRole('dialog');
      for (const [label, day] of [['Expiration date', '11'], ['Termination date', '26'], ['Purchase date', '03']]) {
        const value = detail.locator('dt').filter({ hasText: new RegExp('^' + label + '$') })
          .locator('xpath=following-sibling::dd[1]');
        await value.waitFor();
        assert.equal(await value.innerText(), display(day));
      }
    } finally {
      await page.setViewportSize(viewport);
    }
    await page.goto('/licenses');
    await page.getByLabel('Search table records').fill(name);
    const row = page.getByRole('row').filter({ hasText: name });
    await row.getByRole('cell', { name: display('11'), exact: true }).waitFor();
    await row.getByRole('button', { name: 'update', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const expiration = dialog.getByLabel('Expiration date', { exact: true });
    assert.equal(await expiration.inputValue(), display('11'));
    await expiration.fill('31/02/2026');
    const error = dialog.getByText('Enter a valid date in dd/MM/yyyy format.', { exact: true });
    await error.waitFor();
    await expiration.fill(display('12'));
    await error.waitFor({ state: 'hidden' });
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/v1/licenses/' + license.id) &&
      response.request().method() === 'PATCH');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const response = await saved;
    assert(response.ok());
    assert.equal(response.request().postDataJSON().expiration_date, iso('12'));
    await row.getByRole('cell', { name: display('12'), exact: true }).waitFor();
  });

  await t.test('contact formats validate on input and corrected values can be saved', async () => {
    const dialog = await openCreate(page, '/suppliers');
    await dialog.getByLabel('Name', { exact: true }).fill('UI supplier ' + seed);
    const values = [
      ['Phone', 'tel', '12+abc', '+3908123456', 'Enter digits with an optional leading +.'],
      ['Email', 'email', 'incorrect', 'test@example.com', 'Enter a valid email address.'],
      ['Website', 'url', 'example.com', 'https://example.com', 'Enter a complete URL starting with http:// or https://.'],
    ];
    for (const [label, type, invalid, valid, message] of values) {
      const field = dialog.getByLabel(label, { exact: true });
      assert.equal(await field.getAttribute('type'), type);
      await field.fill(invalid);
      await dialog.getByText(message, { exact: true }).waitFor();
      assert.equal(await field.getAttribute('aria-invalid'), 'true');
      await field.fill(valid);
      await dialog.getByText(message, { exact: true }).waitFor({ state: 'hidden' });
    }
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/v1/suppliers') &&
      response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    assert.equal((await saved).status(), 201);
  });

  await t.test('asset tags are chips and the exact filter supports suggestions and removal', async () => {
    await page.goto('/hardware');
    await page.getByText('Filters and saved searches', { exact: true }).click();
    const tag = page.getByLabel('Exact asset tag', { exact: true });
    await tag.fill(assetTag.slice(0, -2));
    await page.getByRole('list', { name: 'Suggested asset tags' })
      .getByRole('button', { name: assetTag, exact: true }).click();
    const remove = page.getByRole('button', { name: 'Remove tag ' + assetTag, exact: true });
    await remove.waitFor();
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await page.getByRole('cell', { name: assetTag, exact: true }).locator('.k-tag').waitFor();
    await remove.click();
    assert.equal(await tag.inputValue(), '');

    const dialog = await openCreate(page, '/hardware');
    const editable = dialog.getByLabel('Asset tag', { exact: true });
    await editable.fill('new-' + seed);
    await editable.press('Enter');
    await dialog.getByRole('button', { name: 'Remove tag new-' + seed }).click();
    assert.equal(await editable.inputValue(), '');
  });

  await t.test('the Status Labels table shows the color saved in the form', async () => {
    const dialog = await openCreate(page, '/statuslabels');
    const name = 'UI colored status ' + seed;
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByLabel('Color', { exact: true }).fill('#2f6d78');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Changes saved.', { exact: true }).waitFor();
    await page.getByLabel('Search table records').fill(name);
    const row = page.getByRole('row').filter({ hasText: name });
    const swatch = row.getByRole('cell', { name: '#2f6d78' }).locator('.color-swatch');
    await swatch.waitFor();
    assert.equal(await swatch.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(47, 109, 120)');
  });

  await t.test('delete confirmations are centered for single and bulk operations', async () => {
    const name = 'UI deletable category ' + seed;
    await create(page, '/categories', { name, category_type: 'asset' });
    await page.goto('/categories');
    await page.getByLabel('Search table records').fill(name);
    const row = page.getByRole('row').filter({ hasText: name });
    const dialog = page.getByRole('dialog', { name: 'Delete records' });
    const expectCentered = async () => {
      await dialog.waitFor();
      const box = await dialog.boundingBox();
      const viewport = page.viewportSize();
      assert(Math.abs(box.x + box.width / 2 - viewport.width / 2) < 2);
      assert(Math.abs(box.y + box.height / 2 - viewport.height / 2) < 2);
    };
    await row.getByRole('button', { name: 'delete', exact: true }).click();
    await expectCentered();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await row.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expectCentered();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await row.waitFor({ state: 'hidden' });
  });

  await t.test('creating a user keeps Save disabled until required fields and live validators pass', async () => {
    const dialog = await openCreate(page, '/users');
    const user = 'ui-user-' + seed;
    const usernameField = dialog.getByLabel('Username', { exact: true });
    const phone = dialog.getByLabel('Phone', { exact: true });
    const passwordField = dialog.getByLabel('Password', { exact: true });
    const save = dialog.getByRole('button', { name: 'Save', exact: true });
    await dialog.getByText('Password is required.', { exact: true }).waitFor();
    assert.equal(await save.isDisabled(), true);
    await usernameField.fill(user);
    assert.equal(await save.isDisabled(), true);
    await phone.fill('ff3');
    await passwordField.fill('ab');
    const phoneError = dialog.getByText('Enter digits with an optional leading +.', { exact: true });
    const passwordError = dialog.getByText('Use at least 10 characters.', { exact: true });
    await phoneError.waitFor();
    await passwordError.waitFor();
    assert.equal(await phone.getAttribute('aria-invalid'), 'true');
    assert.equal(await passwordField.getAttribute('aria-invalid'), 'true');

    let createRequests = 0;
    const countCreates = (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/users') {
        createRequests++;
      }
    };
    page.on('request', countCreates);
    try {
      assert.equal(await save.isDisabled(), true);
      await dialog.locator('form').evaluate((form) => form.requestSubmit());
      await dialog.getByText('Enter the required values or change a field.', { exact: true }).waitFor();
      assert.equal(createRequests, 0);
    } finally {
      page.off('request', countCreates);
    }

    await phone.fill('+3908123456');
    await passwordField.fill(randomUUID());
    await phoneError.waitFor({ state: 'hidden' });
    await passwordError.waitFor({ state: 'hidden' });
    await usernameField.fill('');
    await save.and(dialog.locator('button:disabled')).waitFor();
    await usernameField.fill(user);
    await save.click();
    await page.getByText('Changes saved.', { exact: true }).waitFor();
  });

  await t.test('license assignment shows the recipient name', async () => {
    const user = await create(page, '/users', {
      username: 'license-recipient-' + seed, display_name: 'License recipient ' + seed,
      email: 'license-' + seed + '@example.test', password: randomUUID(), activated: true,
    });
    const license = await create(page, '/licenses', { name: 'Assigned license ' + seed, seats: 1 });
    await create(page, '/licenses/' + license.id + '/checkout', { target_type: 'user', target_id: user.id });
    await page.goto('/licenses?detail=' + license.id);
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Assignments', exact: true }).click();
    await dialog.getByText(new RegExp('Seat #\\d+ · ' + user.display_name)).waitFor();
    assert.equal(await dialog.getByText('User #' + user.id, { exact: false }).count(), 0);
  });

  await t.test('setup validates password and email before attempting to continue', async () => {
    const setup = await browser.newPage({ baseURL });
    try {
      await setup.route('**/api/v1/setup/status', (route) => route.fulfill({
        json: { setupCompleted: false, checks: { database: true, storageWritable: true } },
      }));
      await setup.goto('/setup');
      await setup.getByRole('button', { name: 'Continue to Instance Settings' }).click();
      await setup.getByRole('button', { name: 'Continue to Superuser Account' }).click();
      await setup.getByLabel('First Name', { exact: true }).fill('Test');
      await setup.getByLabel('Username', { exact: true }).fill('setup-test');
      await setup.getByLabel('Email', { exact: true }).fill('incorrect');
      await setup.getByText('Enter a valid email address.', { exact: true }).waitFor();
      await setup.locator('[formControlName="email"]').fill('setup@example.com');
      const passwordField = setup.getByLabel('Password', { exact: true });
      await passwordField.fill('123456789');
      const error = setup.getByText('Use at least 10 characters.', { exact: true });
      await error.waitFor();
      const next = setup.getByRole('button', { name: 'Complete Setup & Sign In' });
      assert.equal(await next.isDisabled(), true);
      await passwordField.fill(randomUUID());
      await error.waitFor({ state: 'hidden' });
      assert.equal(await next.isEnabled(), true);
    } finally {
      await setup.close();
    }
  });

  await t.test('a rejected access token rotates both cookies and retries without reloading', async () => {
    const session = await signIn(browser);
    try {
      const cookie = async (name) => (await session.context().cookies())
        .find((entry) => entry.name === 'kestrel_' + name + '_token')?.value;
      const originalAccess = await cookie('access');
      const originalRefresh = await cookie('refresh');
      assert(originalAccess && originalRefresh);
      let refreshes = 0;
      let rejections = 0;
      let documents = 0;
      session.on('request', (request) => {
        if (request.url().endsWith('/api/v1/auth/refresh')) refreshes++;
        if (request.resourceType() === 'document') documents++;
      });
      session.on('response', (response) => {
        if (response.status() === 401 && new URL(response.url()).pathname === '/api/v1/hardware') rejections++;
      });
      if (realExpiry === '1') {
        const { exp } = JSON.parse(Buffer.from(originalAccess.split('.')[1], 'base64url'));
        const remaining = exp * 1000 - Date.now();
        assert(remaining < 30_000, 'Use a short JWT_ACCESS_EXPIRES_IN for the real-expiry case.');
        await delay(Math.max(0, remaining) + 250);
      } else {
        // Make the API reject the first request without waiting for the configured TTL.
        await delay(1100);
        await session.route(/\/api\/v1\/hardware(?:\?|$)/, async (route) => {
          const response = await route.fetch({
            headers: { ...route.request().headers(), authorization: 'Bearer invalid-test-token' },
          });
          await route.fulfill({ response });
        }, { times: 1 });
      }
      const renewed = session.waitForResponse((response) =>
        response.url().endsWith('/api/v1/auth/refresh') && response.status() === 200,
      );
      const retried = session.waitForResponse((response) =>
        new URL(response.url()).pathname === '/api/v1/hardware' && response.status() === 200,
      );
      await session.locator('a[href="/hardware"]').first().click();
      await Promise.all([renewed, retried]);
      assert.equal(rejections, 1);
      assert.equal(refreshes, 1);
      assert.equal(documents, 0);
      assert(await cookie('access') !== originalAccess, 'The access token was rotated.');
      assert(await cookie('refresh') !== originalRefresh, 'The refresh token was rotated.');
      await session.getByRole('heading', { name: 'Hardware', exact: true }).waitFor();
      assert.equal(await session.getByText('Invalid or expired token', { exact: true }).count(), 0);
    } finally {
      await session.close();
    }
  });
});

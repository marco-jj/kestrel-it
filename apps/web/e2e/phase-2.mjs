import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chromium } from 'playwright';

const {
  KESTREL_E2E_URL: baseURL,
  KESTREL_E2E_USERNAME: username,
  KESTREL_E2E_PASSWORD: password,
  KESTREL_E2E_CHROMIUM: executablePath,
} = process.env;

assert(
  baseURL && username && password,
  'Configure the disposable test instance as described in e2e/README.md.',
);

async function signIn(browser, account, secret) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account);
  await page.getByLabel('Password', { exact: true }).fill(secret);
  await page.locator('button[type=submit]').click();
  await page.waitForURL('**/dashboard');
  return page;
}

async function api(page, method, path, data) {
  const response = await page.request.fetch('/api/v1' + path, { method, data });
  assert(response.ok(), method + ' ' + path + ' returned ' + response.status());
  const body = await response.json();
  return body.payload ?? body;
}

async function pick(page, label, value) {
  const select = page.locator('kestrel-async-select').filter({
    has: page.getByText(label, { exact: true }),
  });
  await select.getByRole('combobox').fill(value);
  await select.getByRole('option', { name: value, exact: true }).click();
}

test('Phase 2 inventory through Angular and Chromium', { timeout: 90_000 }, async (t) => {
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());
  const page = await signIn(browser, username, password);
  const seed = randomUUID().slice(0, 8);
  const create = (path, data) => api(page, 'POST', path, data);
  const read = (path) => api(page, 'GET', path);
  const category = await create('/categories', {
    name: 'Browser category ' + seed,
    category_type: 'asset',
    require_acceptance: true,
    eula_text: 'Browser test equipment agreement.',
  });
  const [status] = (await read('/statuslabels/selectlist?statusType=deployable')).results;
  assert(status, 'The instance needs a deployable status label.');

  await t.test(
    'edit and delete permissions independently expose bulk directory actions',
    async () => {
      const name = 'Bulk directory ' + seed;
      const target = await create('/categories', { name, category_type: 'asset' });
      const listing = '/categories';
      const accounts = [
        { username: 'editor-' + seed, permissions: { 'categories.view': 1, 'categories.edit': 1 } },
        {
          username: 'deleter-' + seed,
          permissions: { 'categories.view': 1, 'categories.delete': 1 },
        },
      ];
      const accountPassword = randomUUID();
      for (const account of accounts) {
        await create('/users', { ...account, activated: true, password: accountPassword });
      }

      async function selectRow(operator) {
        await operator.getByRole('row').filter({ hasText: name }).getByRole('checkbox').check();
      }

      const editor = await signIn(browser, accounts[0].username, accountPassword);
      await editor.goto(listing);
      await editor.getByLabel('Search table records').fill(name);
      await selectRow(editor);
      await editor.getByRole('button', { name: 'Bulk Edit', exact: true }).click();
      await editor.getByLabel('Notes', { exact: true }).fill('Bulk edit from Chromium');
      await editor.getByRole('button', { name: 'Save', exact: true }).click();
      await editor.getByText('Changes saved.', { exact: true }).waitFor();
      assert.equal((await read(listing + '/' + target.id)).notes, 'Bulk edit from Chromium');
      await editor.context().close();

      const deleter = await signIn(browser, accounts[1].username, accountPassword);
      await deleter.goto(listing);
      await deleter.getByLabel('Search table records').fill(name);
      await selectRow(deleter);
      await deleter.getByRole('button', { name: 'Delete', exact: true }).click();
      await deleter
        .getByRole('dialog')
        .getByRole('button', { name: 'Delete', exact: true })
        .click();
      await deleter.getByRole('row').filter({ hasText: name }).waitFor({ state: 'hidden' });
      await deleter.getByRole('button', { name: 'Show deleted records' }).click();
      await selectRow(deleter);
      await deleter.getByRole('button', { name: 'Restore', exact: true }).click();
      await deleter
        .getByRole('dialog')
        .getByRole('button', { name: 'Restore', exact: true })
        .click();
      await deleter.getByRole('row').filter({ hasText: name }).waitFor({ state: 'hidden' });
      assert.equal((await read(listing + '/' + target.id)).id, target.id);
      await deleter.context().close();
    },
  );

  const shared = await create('/fields', { name: 'Shared field ' + seed, element: 'text' });
  const old = await create('/fields', {
    name: 'Required secret ' + seed,
    element: 'text',
    field_encrypted: true,
  });
  const source = await create('/fieldsets', { name: 'Source fieldset ' + seed });
  const destination = await create('/fieldsets', { name: 'Destination fieldset ' + seed });
  await create(`/fieldsets/${source.id}/fields`, { field_id: old.id, required: true });
  for (const set of [source, destination]) {
    await create(`/fieldsets/${set.id}/fields`, { field_id: shared.id });
  }
  const from = await create('/models', {
    name: 'Original model ' + seed,
    category_id: category.id,
    fieldset_id: source.id,
  });
  const to = await create('/models', {
    name: 'Destination model ' + seed,
    category_id: category.id,
    fieldset_id: destination.id,
  });
  const company = await create('/companies', { name: 'Original company ' + seed });
  const destinationCompany = await create('/companies', { name: 'Destination company ' + seed });
  const pickerRequest = (path, companyId) =>
    page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === '/api/v1' + path && url.searchParams.get('companyId') === String(companyId)
      );
    });
  const tags = ['A', 'B'].map((label) => 'BROW-' + seed + '-' + label);
  const assets = [];
  for (const tag of tags) {
    assets.push(
      await create('/hardware', {
        asset_tag: tag,
        model_id: from.id,
        company_id: company.id,
        status_id: status.id,
        custom_fields: {
          [old.db_column]: 'Browser test value',
          [shared.db_column]: 'Original value',
        },
      }),
    );
  }
  const row = (tag) => page.getByRole('row').filter({ hasText: tag });

  await t.test('confirm model changes and edit common custom fields in bulk', async () => {
    await page.goto('/hardware');
    await page.getByLabel('Search table records', { exact: true }).fill('BROW-' + seed);
    await row(tags[0]).getByRole('button', { name: 'update', exact: true }).click();
    const scopedLocations = pickerRequest('/locations/selectlist', destinationCompany.id);
    await pick(page, 'Company', destinationCompany.name);
    await scopedLocations;
    await pick(page, 'Model', to.name);
    await page.getByLabel(/Remove saved values/).waitFor();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Confirm removal' }).waitFor();
    await page.getByLabel(/Remove saved values/).check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Changes saved.', { exact: true }).waitFor();
    const moved = await read(`/hardware/${assets[0].id}`);
    assert.equal(moved.model_id, to.id);
    assert.equal(moved.company_id, destinationCompany.id);
    assert.equal(moved.custom_fields[shared.name].value, 'Original value');
    assert.equal(moved.custom_fields[old.name], undefined);

    for (const tag of tags) await row(tag).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Bulk Edit', exact: true }).click();
    const field = page.getByLabel(shared.name, { exact: true });
    await field.waitFor();
    assert.equal(await page.getByLabel(old.name, { exact: true }).count(), 0);
    await field.fill('Bulk value');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Changes saved.', { exact: true }).waitFor();
    for (const { id } of assets) {
      assert.equal((await read(`/hardware/${id}`)).custom_fields[shared.name].value, 'Bulk value');
    }
  });

  await t.test('check out, sign in person, and download the historical EULA', async () => {
    const assignee = await create('/users', {
      username: 'assignee-' + seed,
      first_name: 'Browser',
      last_name: 'Assignee ' + seed,
      activated: true,
    });
    const scopedUsers = pickerRequest('/hardware/targets/user', destinationCompany.id);
    await row(tags[0]).getByRole('button', { name: 'checkout', exact: true }).click();
    await scopedUsers;
    await pick(page, 'Checkout target', assignee.first_name + ' ' + assignee.last_name);
    await page.getByLabel('Have the assignee sign here').check();
    await page.getByRole('button', { name: 'Check out', exact: true }).click();
    await page.waitForURL('**/account/accept/*');
    const canvas = page.locator('canvas');
    await canvas.waitFor();
    const box = await canvas.boundingBox();
    assert(box, 'Enable require_accept_signature in the test instance.');
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 10 });
    await page.mouse.up();
    await page.getByRole('button', { name: 'Accept', exact: true }).click();
    const download = page.getByRole('button', { name: 'Download signed EULA' });
    const [pdf] = await Promise.all([page.waitForEvent('download'), download.click()]);
    assert.match(pdf.suggestedFilename(), /\.pdf$/);
    const signed = await read(new URL(page.url()).pathname);
    assert.equal(signed.state, 'accepted');
    assert.equal(signed.has_signature, true);

    const secondCheckout = await create(`/hardware/${assets[1].id}/checkout`, {
      target_type: 'user',
      target_id: assignee.id,
      sign_in_place: true,
    });
    const next = '/account/accept/' + secondCheckout.acceptance_id;
    // Trigger an in-app history navigation so Angular reuses the acceptance detail component.
    await page.evaluate((path) => {
      window.history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, next);
    await page.getByRole('heading', { name: tags[1] }).waitFor();
    await page.getByRole('button', { name: 'Accept', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Sign the form before accepting.' }).waitFor();

    await page.goto('/hardware');
    await page.getByLabel('Search table records', { exact: true }).fill(tags[1]);
    const returnLocations = pickerRequest('/hardware/targets/location', company.id);
    await row(tags[1]).getByRole('button', { name: 'checkin', exact: true }).click();
    await returnLocations;
  });
});

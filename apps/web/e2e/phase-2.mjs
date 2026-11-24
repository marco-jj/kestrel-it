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

test(
  'Phase 3 inventory and operations through Angular and Chromium',
  { timeout: 150_000 },
  async (t) => {
    const browser = await chromium.launch({ executablePath });
    t.after(() => browser.close());
    const page = await signIn(browser, username, password);
    const marker = randomUUID().slice(0, 8);
    const create = (path, data) => api(page, 'POST', path, data);
    const read = (path) => api(page, 'GET', path);
    const receiverName = 'phase3-' + marker;
    const receiver = await create('/users', {
      username: receiverName,
      first_name: 'Receiver',
      last_name: marker,
      activated: true,
      password: randomUUID(),
    });
    const stock = await create('/accessories', { name: 'Browser accessory ' + marker, qty: 2 });
    const kit = await create('/kits', { name: 'Browser kit ' + marker });
    await create(`/kits/${kit.id}/accessories`, { item_id: stock.id, quantity: 1 });
    const category = await create('/categories', {
      name: 'Browser audit category ' + marker,
      category_type: 'asset',
    });
    const model = await create('/models', {
      name: 'Browser audit model ' + marker,
      category_id: category.id,
    });
    const [status] = (await read('/statuslabels/selectlist?statusType=deployable')).results;
    const asset = await create('/hardware', {
      model_id: model.id,
      status_id: status.id,
      asset_tag: 'AUDIT-' + marker,
    });
    const dialog = page.getByRole('dialog');

    await t.test('checks out a kit and records its replenishment order', async () => {
      await page.goto('/kits?detail=' + kit.id);
      await dialog.getByRole('button', { name: 'Check out', exact: true }).click();
      await pick(page, 'User', 'Receiver ' + marker);
      await dialog.getByRole('button', { name: 'Check out', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Change saved.' }).waitFor();
      const assignments = await read(`/accessories/${stock.id}/checkedout`);
      assert.equal(assignments.rows[0].target_id, receiver.id);

      await page.goto('/accessories?detail=' + stock.id);
      await dialog.getByRole('button', { name: 'Adjust quantity', exact: true }).click();
      await dialog.getByLabel('Quantity adjustment', { exact: true }).fill('3');
      await dialog.getByLabel('Order number', { exact: true }).fill('PO-' + marker);
      await dialog.getByLabel('Unit cost', { exact: true }).fill('8.50');
      await dialog.getByLabel('Currency', { exact: true }).fill('EUR');
      await dialog.getByRole('button', { name: 'Adjust quantity', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Change saved.' }).waitFor();
      await dialog.getByRole('button', { name: 'Orders', exact: true }).click();
      await dialog
        .getByRole('row')
        .filter({ hasText: 'PO-' + marker })
        .waitFor();
      assert.equal((await read('/accessories/' + stock.id)).remaining, 4);
    });

    await t.test('records an audit photo and shows the audit in the calendar', async () => {
      const date = new Date().toISOString().slice(0, 10);
      await page.goto('/hardware');
      await page.getByLabel('Search table records').fill(asset.asset_tag);
      await page
        .getByRole('row')
        .filter({ hasText: asset.asset_tag })
        .getByRole('button', { name: 'audit', exact: true })
        .click();
      await dialog.getByLabel('Next audit date', { exact: true }).fill(date);
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACklEQVR4AWPAAAAAEgABKPhxBgAAAABJRU5ErkJggg==',
        'base64',
      );
      await dialog
        .getByLabel('Audit photo')
        .setInputFiles({ name: 'audit.png', mimeType: 'image/png', buffer: png });
      await dialog.getByRole('button', { name: 'Record audit' }).click();
      await page.getByRole('status').filter({ hasText: 'Audit recorded.' }).waitFor();
      await page
        .getByRole('row')
        .filter({ hasText: asset.asset_tag })
        .getByRole('button', { name: 'view', exact: true })
        .click();
      const download = page.waitForEvent('download');
      await dialog.getByRole('button', { name: 'Download photo' }).click();
      assert.match((await download).suggestedFilename(), /^audit-\d+\.png$/);
      await page.goto('/calendar');
      await page.getByLabel('Event type').selectOption('asset.audit_due');
      await page
        .getByRole('link', { name: 'Audit due · ' + asset.asset_tag, exact: true })
        .filter({ visible: true })
        .click();
      await page.waitForURL('**/hardware?detail=' + asset.id);
    });

    await t.test('completes maintenance and writes its history', async () => {
      const types = await read('/maintenance-types/selectlist');
      const maintenance = await create('/maintenances', {
        name: 'Browser inspection ' + marker,
        asset_id: asset.id,
        maintenance_type_id: types.results[0].id,
        start_date: new Date().toISOString().slice(0, 10),
      });
      await page.goto('/maintenances?detail=' + maintenance.id);
      await dialog.getByRole('button', { name: 'Complete maintenance' }).click();
      await dialog.getByLabel('Completion note').fill('Inspection finished in Chromium');
      await dialog.getByRole('button', { name: 'Complete maintenance' }).click();
      await page.getByRole('status').filter({ hasText: 'Change saved.' }).waitFor();
      await dialog.getByRole('button', { name: 'History', exact: true }).click();
      await dialog.getByText(/Inspection finished in Chromium/).waitFor();
      assert((await read('/maintenances/' + maintenance.id)).completed_at);
    });
  },
);

test('Phase 3.3 and 3.4 operational workflows through Angular and Chromium', { timeout: 90_000 }, async (t) => {
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());
  const page = await signIn(browser, username, password);
  const marker = randomUUID().slice(0, 8);
  const create = (path, data) => api(page, 'POST', path, data);
  const read = (path) => api(page, 'GET', path);
  const category = await create('/categories', { name: 'Operational category ' + marker,
    category_type: 'asset', require_acceptance: true, alert_on_response: true });
  const model = await create('/models', { name: 'Operational model ' + marker, category_id: category.id });
  const [status] = (await read('/statuslabels/selectlist?statusType=deployable')).results;
  const asset = await create('/hardware', { name: 'Operational asset ' + marker, model_id: model.id,
    status_id: status.id, asset_tag: 'OP-' + marker });
  const receiver = await create('/users', { username: 'operations-' + marker,
    email: 'operations-' + marker + '@example.test', activated: true, password: randomUUID() });

  await t.test('uploads, downloads, and removes an asset attachment', async () => {
    await page.goto('/hardware?detail=' + asset.id);
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Files', exact: true }).click();
    await dialog.getByLabel('Attachments').setInputFiles({
      name: 'asset-manual.txt', mimeType: 'text/plain', buffer: Buffer.from('Operational attachment'),
    });
    await dialog.getByLabel('Note', { exact: true }).fill('Browser attachment');
    await dialog.getByRole('button', { name: 'Upload files' }).click();
    await dialog.getByRole('status').filter({ hasText: 'Attachments uploaded' }).waitFor();
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download asset-manual.txt' }).click();
    assert.equal((await download).suggestedFilename(), 'asset-manual.txt');
    await dialog.getByRole('button', { name: 'Delete asset-manual.txt' }).click();
    await dialog.getByRole('button', { name: 'Confirm delete' }).click();
    await dialog.getByRole('status').filter({ hasText: 'Attachment deleted' }).waitFor();
    assert.equal((await read('/hardware/' + asset.id + '/files')).total, 0);
  });

  await t.test('previews a custom label and prints a hardware label', async () => {
    await page.goto('/admin/labels');
    await page.getByLabel('Template name').fill('Browser label ' + marker);
    await page.getByRole('button', { name: 'Save label template' }).click();
    await page.getByRole('status').filter({ hasText: 'Label template saved' }).waitFor();
    await page.getByRole('button', { name: 'Preview label' }).click();
    await page.locator('iframe[title="Label preview"]').waitFor();
    const preview = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download preview PDF' }).click();
    assert.equal((await preview).suggestedFilename(), 'label-preview.pdf');
    await page.goto('/hardware?detail=' + asset.id);
    const download = page.waitForEvent('download');
    await page.getByRole('dialog').getByRole('button', { name: 'Print label', exact: true }).click();
    assert.equal((await download).suggestedFilename(), 'asset-labels.pdf');
  });

  await t.test('saves a custom report template and downloads CSV and Excel', async () => {
    await page.goto('/reports/custom');
    await page.getByRole('heading', { name: 'Custom Assets' }).waitFor();
    await page.getByText('Columns and report templates', { exact: true }).click();
    await page.getByLabel('Template name').fill('Browser report ' + marker);
    await page.getByLabel('Share with report viewers').check();
    await page.getByRole('button', { name: 'Save template' }).click();
    await page.getByRole('status').filter({ hasText: 'Report template saved' }).waitFor();
    for (const [label, extension] of [['Export CSV', 'csv'], ['Export Excel', 'xlsx']]) {
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: label, exact: true }).click();
      assert.equal((await download).suggestedFilename(), 'custom.' + extension);
    }
  });

  await t.test('persists the depreciation method and opens the complete audit queue', async () => {
    await page.goto('/depreciations');
    const method = page.getByLabel('Depreciation method', { exact: true });
    await method.selectOption('half_2');
    await page.getByRole('button', { name: 'Save method', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Depreciation method saved' }).waitFor();
    assert.equal((await read('/depreciations/settings')).depreciation_method, 'half_2');
    await page.reload();
    assert.equal(await method.inputValue(), 'half_2');
    await method.selectOption('default');
    await page.getByRole('button', { name: 'Save method', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Depreciation method saved' }).waitFor();
    await page.goto('/hardware/audit/due-or-overdue');
    await page.getByRole('heading', { name: 'Due and overdue audits', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Overdue audits', exact: true }).click();
    await page.getByRole('heading', { name: 'Overdue audits', exact: true }).waitFor();

    const fresh = await browser.newContext({ baseURL });
    const freshPage = await fresh.newPage();
    freshPage.setDefaultTimeout(10_000);
    await freshPage.goto('/hardware/audit/due-or-overdue');
    await freshPage.waitForURL('**/login?redirect=*');
    await freshPage.getByLabel('Username', { exact: true }).fill(username);
    await freshPage.getByLabel('Password', { exact: true }).fill(password);
    await freshPage.locator('button[type=submit]').click();
    await freshPage.waitForURL('**/hardware/audit/due-or-overdue');
    await freshPage.getByRole('heading', { name: 'Due and overdue audits', exact: true }).waitFor();
    await fresh.close();
  });

  await t.test('processes a CSV with one rejected row and keeps the successful row', async () => {
    await page.goto('/import');
    await page.getByLabel('CSV files', { exact: true }).setInputFiles({
      name: 'mixed-stock.csv', mimeType: 'text/csv',
      buffer: Buffer.from('Name,Quantity\nBrowser import ' + marker + ',3\nBroken import ' + marker + ',a'),
    });
    await page.getByRole('button', { name: 'Upload CSV files' }).click();
    await page.getByLabel('Import type').selectOption({ label: 'Accessories' });
    await page.getByLabel('Map Quantity').locator('option').filter({ hasText: 'qty' }).waitFor({ state: 'attached' });
    await page.getByRole('button', { name: 'Process CSV' }).click();
    await page.getByText(/complete · 2 processed · 1 created/).waitFor();
    await page.getByText(/Row 3:/).waitFor();
    assert.equal((await read('/accessories?search=' + encodeURIComponent('Browser import ' + marker))).total, 1);
  });

  await t.test('queues a scoped acceptance reminder and saves notification settings', async () => {
    await create('/hardware/' + asset.id + '/checkout', { target_type: 'user', target_id: receiver.id });
    await page.goto('/reports/unaccepted-assets');
    await page.getByLabel(asset.asset_tag, { exact: true }).check();
    await page.getByRole('button', { name: 'Send reminders' }).click();
    await page.getByRole('status').filter({ hasText: '1 reminder(s) queued.' }).waitFor();
    await page.goto('/admin/notifications');
    await page.getByLabel('Low-stock buffer').fill('7');
    await page.getByRole('button', { name: 'Save notification settings' }).click();
    await page.getByRole('status').filter({ hasText: 'Notification settings saved' }).waitFor();
    assert.equal((await read('/settings/notifications')).alert_threshold, 7);
    await page.getByLabel('Test recipient').fill('phase34@example.test');
    await page.getByRole('button', { name: 'Send test email' }).click();
    await page.getByRole('status').filter({ hasText: 'Test email queued' }).waitFor();
  });

  await t.test(
    'covers live dashboard telemetry, hardware detail subtabs, secondary requestables, self-service account, and admin settings',
    async () => {
      const reqAccessory = await create('/accessories', {
        name: 'Req Dock ' + marker,
        qty: 4,
        requestable: true,
      });

      await page.goto('/dashboard');
      await page.getByRole('heading', { name: 'IT Asset Operations Cockpit' }).waitFor();
      assert.equal(await page.getByText('Phase 2.3').count(), 0);
      await page.getByText('HARDWARE ASSETS', { exact: true }).waitFor();

      await page.goto('/hardware/' + asset.id);
      await page.getByRole('button', { name: 'Components', exact: true }).click();
      await page.getByRole('button', { name: 'Accessories', exact: true }).click();
      await page.getByRole('button', { name: 'Maintenances', exact: true }).click();
      await page.getByRole('button', { name: 'Licenses', exact: true }).click();

      await page.goto('/account/requestable');
      await page.getByRole('button', { name: 'Accessories', exact: true }).click();
      const accRow = page.getByRole('row').filter({ hasText: reqAccessory.name });
      await accRow.waitFor();
      await accRow.getByRole('button', { name: 'request', exact: true }).click();
      await page.getByLabel('Quantity').fill('2');
      await page.getByRole('button', { name: 'Submit request', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Request submitted.' }).waitFor();

      await page.goto('/requests');
      const queueRow = page.getByRole('row').filter({ hasText: reqAccessory.name });
      await queueRow.getByRole('button', { name: 'checkout', exact: true }).click();
      await page.getByRole('button', { name: 'Fulfill request', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Request fulfilled.' }).waitFor();

      await page.goto('/account/profile');
      await page.getByRole('heading', { name: 'My Profile' }).waitFor();
      await page.getByLabel('Phone', { exact: true }).fill('+39 02 998877');
      await page.getByRole('button', { name: 'Save Profile', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Profile details updated' }).waitFor();

      await page.goto('/account/view-assets');
      await page.getByRole('heading', { name: 'My Assigned Inventory' }).waitFor();

      await page.goto('/account/api');
      await page.getByLabel('Token name', { exact: true }).fill('E2E Token ' + marker);
      await page.getByRole('button', { name: 'Generate Token', exact: true }).click();
      await page.getByText(/Copy your new token now/).waitFor();
      await page.getByRole('button', { name: 'Revoke', exact: true }).first().click();

      await page.goto('/admin/settings');
      await page.getByRole('heading', { name: 'Administration Settings' }).waitFor();
      await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Settings saved' }).waitFor();

      await page.goto('/admin/branding');
      await page.getByRole('heading', { name: 'Colors, Banners & Custom CSS' }).waitFor();
      await page.goto('/admin/integrations');
      await page.getByRole('heading', { name: 'OIDC / OAuth 2.1 Single Sign-On' }).waitFor();
      await page.goto('/admin/login-attempts');
      await page.getByRole('heading', { name: 'Login Attempts Audit' }).waitFor();
    },
  );
});

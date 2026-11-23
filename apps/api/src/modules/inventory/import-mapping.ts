import { type ImportType } from '@kestrel-it/shared';
import { UnprocessableEntityException } from '@nestjs/common';
import { parse as csvParser } from 'csv-parse';
import { Readable } from 'node:stream';

const common = ['name', 'notes'];
const inventory = [
  ...common,
  'category',
  'manufacturer',
  'company',
  'supplier',
  'purchase_date',
  'purchase_cost',
  'order_number',
  'min_amt',
  'requestable',
];
const stock = [...inventory, 'location', 'qty', 'model_number', 'archived'];
const address = ['address', 'address2', 'city', 'state', 'country', 'zip', 'phone', 'fax'];
const checkout = [
  'assigned_to',
  'assigned_email',
  'checkout_user',
  'checkout_asset',
  'checkout_location',
  'checkout_class',
  'checkout_at',
  'checkout_note',
  'expected_checkin',
];
export const importFields: Record<ImportType, string[]> = {
  asset: [
    ...inventory.filter((field) => field !== 'min_amt'),
    'asset_tag',
    'serial',
    'model',
    'model_number',
    'status',
    'location',
    'rtd_location',
    'warranty_months',
    'asset_eol_date',
    'byod',
    ...checkout,
  ],
  assetHistory: [
    'asset_tag',
    'assigned_to',
    'assigned_email',
    'checkout_user',
    'checkout_location',
    'checkout_class',
    'checkout_at',
    'checkin_at',
    'checkout_note',
    'checkin_note',
    'expected_checkin',
  ],
  assetModel: [
    ...common,
    'model_number',
    'category',
    'manufacturer',
    'depreciation',
    'fieldset',
    'eol',
    'min_amt',
    'require_serial',
    'requestable',
  ],
  user: [
    'username',
    'first_name',
    'last_name',
    'display_name',
    'email',
    'employee_num',
    'jobtitle',
    'company',
    'location',
    'department',
    'manager',
    'group',
    'phone',
    'mobile',
    'notes',
    'locale',
    'activated',
    'start_date',
    'end_date',
  ],
  license: [
    ...inventory,
    'serial',
    'seats',
    'license_name',
    'license_email',
    'purchase_order',
    'reassignable',
    'maintained',
    'depreciate',
    'expiration_date',
    'termination_date',
    'depreciation',
    'asset_tag',
    ...checkout,
  ],
  accessory: [...stock, 'asset_tag', ...checkout],
  consumable: [...stock, 'item_no', ...checkout],
  component: [...stock, 'serial', 'asset_tag', ...checkout],
  location: [...common, ...address, 'company', 'parent', 'manager', 'currency'],
  category: [
    ...common,
    'category_type',
    'eula_text',
    'use_default_eula',
    'require_acceptance',
    'alert_on_response',
    'checkin_email',
  ],
  manufacturer: [
    ...common,
    'url',
    'support_url',
    'warranty_lookup_url',
    'support_phone',
    'support_email',
  ],
  supplier: [...common, ...address, 'contact', 'email', 'url'],
};

const aliases: Record<string, string> = {
  item_name: 'name',
  asset_name: 'name',
  license_key: 'serial',
  product_key: 'serial',
  model_name: 'model',
  model_no: 'model_number',
  serial_number: 'serial',
  status_label: 'status',
  quantity: 'qty',
  minimum_quantity: 'min_amt',
  min_quantity: 'min_amt',
  item_number: 'item_no',
  user_name: 'username',
  first_name: 'first_name',
  last_name: 'last_name',
  employee_number: 'employee_num',
  last_checkout: 'checkout_at',
  checkout_date: 'checkout_at',
  check_out_date: 'checkout_at',
  checkin_date: 'checkin_at',
  check_in_date: 'checkin_at',
  assigned_user: 'assigned_to',
  checkout_to: 'assigned_to',
  assigned_user_email: 'assigned_email',
  parent_location: 'parent',
  default_location: 'rtd_location',
  depreciation_name: 'depreciation',
  fieldset_name: 'fieldset',
  company_name: 'company',
  category_name: 'category',
  manufacturer_name: 'manufacturer',
  supplier_name: 'supplier',
  current_location: 'location',
  purchase_order_number: 'purchase_order',
  cost: 'purchase_cost',
  warranty: 'warranty_months',
  type: 'category_type',
};
export const normalizedHeader = (value: string) =>
  value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

export function automaticMapping(
  type: ImportType,
  headers: string[],
  custom: Record<string, string> = {},
) {
  const used = new Set<string>();
  return Object.fromEntries(
    headers.map((header, index) => {
      const key = normalizedHeader(header);
      const available = importFields[type];
      const candidate =
        type === 'assetModel' && key === 'model_name'
          ? 'name'
          : (custom[key] ?? (available.includes(key) ? key : aliases[key]));
      if (
        !candidate ||
        used.has(candidate) ||
        (!available.includes(candidate) && !candidate.startsWith('custom:'))
      )
        return [String(index), null];
      used.add(candidate);
      return [String(index), candidate];
    }),
  );
}

function delimiter(header: string) {
  const scores: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const character of header) {
    if (character === '"') quoted = !quoted;
    if (!quoted && (character === '\n' || character === '\r')) break;
    if (!quoted && Object.hasOwn(scores, character)) scores[character]! += 1;
  }
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0]![0];
}

export async function* csvRows(source: Readable): AsyncGenerator<string[]> {
  const iterator = source[Symbol.asyncIterator]();
  const prefix: Buffer[] = [];
  let size = 0;
  try {
    while (size < 8192) {
      const first = await iterator.next();
      if (first.done) break;
      const chunk = Buffer.from(first.value);
      prefix.push(chunk);
      size += chunk.length;
      if (chunk.includes(10) && size >= 128) break;
    }
    const sample = Buffer.concat(prefix);
    if (!sample.length) throw new UnprocessableEntityException('CSV is empty');
    const encoding =
      sample[0] === 0xff && sample[1] === 0xfe
        ? 'utf-16le'
        : sample[0] === 0xfe && sample[1] === 0xff
          ? 'utf-16be'
          : 'utf-8';
    let decoder = new TextDecoder(encoding, { fatal: true });
    let header: string;
    try {
      header = decoder.decode(sample, { stream: true });
    } catch {
      if (encoding !== 'utf-8')
        throw new UnprocessableEntityException('Invalid CSV character encoding');
      decoder = new TextDecoder('windows-1252');
      header = decoder.decode(sample, { stream: true });
    }
    if (header.includes('\0')) throw new UnprocessableEntityException('Expected a CSV text file');
    const input = Readable.from(
      (async function* () {
        yield header;
        while (true) {
          const chunk = await iterator.next();
          if (chunk.done) break;
          yield decoder.decode(chunk.value, { stream: true });
        }
        yield decoder.decode();
      })(),
    );
    const records = csvParser({
      delimiter: delimiter(header),
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      max_record_size: 128 * 1024,
    });
    input.on('error', (error) => records.destroy(error));
    input.pipe(records);
    try {
      for await (const record of records) {
        const row = record as string[];
        if (row.some((cell) => cell.trim())) yield row;
      }
    } finally {
      input.destroy();
      records.destroy();
    }
  } finally {
    source.destroy();
  }
}

export function dateCell(value: string): string {
  const normalized = value.trim();
  const slashes = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(normalized);
  const date = slashes
    ? `${slashes[3]}-${slashes[1]!.padStart(2, '0')}-${slashes[2]!.padStart(2, '0')}`
    : normalized.replace(
        /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/,
        (_m, year: string, month: string, day: string) =>
          `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
      );
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    throw new UnprocessableEntityException('Invalid date');
  return date;
}

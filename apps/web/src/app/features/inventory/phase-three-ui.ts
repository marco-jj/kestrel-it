import { FormControl, FormGroup, Validators } from '@angular/forms';
import type { DataGridColumn, DataGridRow } from '../../shared/ui/data-grid.component.js';
import { field, reference, type InventoryField } from './directory-ui.js';

export const phaseThreeResources = [
  'licenses',
  'accessories',
  'consumables',
  'components',
  'kits',
  'maintenances',
  'maintenance-types',
  'depreciations',
] as const;
export type PhaseThreeResource = (typeof phaseThreeResources)[number];

export const required = (config: InventoryField): InventoryField => ({ ...config, required: true });
export const choice = (key: string, label: string, options: readonly string[]): InventoryField => ({
  ...field(key, label, 'enum'),
  options,
});

export function inventoryForm(fields: InventoryField[], values: DataGridRow = {}) {
  return new FormGroup(
    Object.fromEntries(
      fields.map((item) => [
        item.key,
        new FormControl(
          values[item.key] ?? (item.type === 'boolean' ? false : null),
          item.required ? Validators.required : undefined,
        ),
      ]),
    ),
  );
}

const column = (key: string, label: string): DataGridColumn => ({ key, label, sortable: false });
const name = required(field('name', 'Name'));
const categoryFields = [
  name,
  reference('category_id', 'Category', 'categories'),
  reference('company_id', 'Company', 'companies'),
  reference('manufacturer_id', 'Manufacturer', 'manufacturers'),
  field('min_amt', 'Minimum stock', 'number'),
  field('requestable', 'Requestable', 'boolean'),
  field('notes', 'Notes', 'textarea'),
];
const stockFields = [
  ...categoryFields,
  reference('location_id', 'Location', 'locations'),
  reference('default_supplier_id', 'Supplier', 'suppliers'),
  field('model_number', 'Model number'),
  field('qty', 'Initial quantity', 'number'),
  field('default_purchase_cost', 'Default purchase cost'),
  field('legacy_order_number', 'Legacy order number'),
  field('legacy_purchase_date', 'Legacy purchase date', 'date'),
  field('archived', 'Archived', 'boolean'),
];
const stocks = [column('qty', 'Stock'), column('remaining', 'Available')];

export const phaseThreeDefinitions: Record<
  PhaseThreeResource,
  { title: string; fields: InventoryField[]; columns: DataGridColumn[] }
> = {
  licenses: {
    title: 'Licenses',
    columns: [
      column('seats', 'Seats'),
      column('remaining', 'Free seats'),
      column('expiration_date', 'Expires'),
    ],
    fields: [
      ...categoryFields,
      field('serial', 'Product key', 'textarea'),
      required(field('seats', 'Seats', 'number')),
      field('reassignable', 'Reassignable', 'boolean'),
      field('maintained', 'Maintained', 'boolean'),
      field('expiration_date', 'Expiration date', 'date'),
      field('termination_date', 'Termination date', 'date'),
      field('purchase_cost', 'Purchase cost'),
      field('purchase_date', 'Purchase date', 'date'),
      field('order_number', 'Order number'),
      field('purchase_order', 'Purchase order'),
      field('license_name', 'Licensed to'),
      field('license_email', 'License email'),
      reference('supplier_id', 'Supplier', 'suppliers'),
      field('depreciate', 'Depreciate', 'boolean'),
      reference('depreciation_id', 'Depreciation schedule', 'depreciations'),
    ],
  },
  accessories: { title: 'Accessories', fields: stockFields, columns: stocks },
  consumables: {
    title: 'Consumables',
    fields: [...stockFields, field('item_no', 'Item number')],
    columns: stocks,
  },
  components: {
    title: 'Components',
    fields: [...stockFields, field('serial', 'Serial')],
    columns: stocks,
  },
  kits: { title: 'Predefined kits', fields: [name], columns: [] },
  maintenances: {
    title: 'Maintenance',
    columns: [
      column('asset_id', 'Asset ID'),
      column('start_date', 'Start'),
      column('completed_at', 'Completed'),
    ],
    fields: [
      name,
      required(reference('asset_id', 'Asset', 'hardware')),
      required(reference('maintenance_type_id', 'Maintenance type', 'maintenance-types')),
      reference('supplier_id', 'Supplier', 'suppliers'),
      reference('responsible_party_id', 'Responsible party', 'users'),
      required(field('start_date', 'Start date', 'date')),
      field('expected_completion_date', 'Expected completion', 'date'),
      field('cost', 'Cost'),
      field('is_warranty', 'Under warranty', 'boolean'),
      field('url', 'Reference URL'),
      field('notes', 'Notes', 'textarea'),
    ],
  },
  'maintenance-types': { title: 'Maintenance types', fields: [name], columns: [] },
  depreciations: {
    title: 'Depreciation schedules',
    columns: [
      column('months', 'Months'),
      column('depreciation_min', 'Minimum value'),
      column('depreciation_type', 'Floor type'),
    ],
    fields: [
      name,
      required(field('months', 'Term in months', 'number')),
      required(choice('depreciation_type', 'Floor type', ['amount', 'percent'])),
      field('depreciation_min', 'Minimum value'),
      field('fiscal_year_start_month', 'Fiscal start month', 'number'),
      field('rate_multiplier', 'Diminishing balance multiplier'),
    ],
  },
};

import {
  CATEGORY_TYPES,
  WEBHOOK_PROVIDERS,
  type CoreInventoryResource,
  type PermissionKey,
} from '@kestrel-it/shared';

export interface InventoryField {
  key: string;
  label: string;
  type?:
    | 'text'
    | 'boolean'
    | 'number'
    | 'reference'
    | 'textarea'
    | 'enum'
    | 'ids'
    | 'permissions'
    | 'password'
    | 'date';
  options?: readonly string[];
  resource?: string;
  optionsPath?: string;
  required?: boolean;
  superuserOnly?: boolean;
}

export interface InventoryPageDefinition {
  title: string;
  permission: string;
  fields: InventoryField[];
}

export const field = (
  key: string,
  label: string,
  type?: InventoryField['type'],
): InventoryField => ({ key, label, type });
export const reference = (key: string, label: string, resource: string): InventoryField => ({
  key,
  label,
  type: 'reference',
  resource,
});
export const permissionFor = (resource: string, action: string) =>
  `${resource}.${action}` as PermissionKey;
const name: InventoryField = { key: 'name', label: 'Name', required: true };
const notes = field('notes', 'Notes', 'textarea');
const phone = field('phone', 'Phone');
const fax = field('fax', 'Fax');
const address = [
  field('address', 'Address'),
  field('address2', 'Address line 2'),
  field('city', 'City'),
  field('state', 'State'),
  field('zip', 'Postal code'),
  field('country', 'Country'),
];
const company = reference('company_id', 'Company', 'companies');
const location = reference('location_id', 'Location', 'locations');
const manager = reference('manager_id', 'Manager', 'users');

export const DIRECTORY_UI: Record<CoreInventoryResource, InventoryPageDefinition> = {
  companies: {
    title: 'Companies',
    permission: 'companies',
    fields: [
      name,
      reference('parent_id', 'Parent company', 'companies'),
      {
        ...field('webhook_selected', 'Webhook provider', 'enum'),
        options: WEBHOOK_PROVIDERS,
        superuserOnly: true,
      },
      { ...field('webhook_endpoint', 'Webhook endpoint'), superuserOnly: true },
      { ...field('webhook_channel', 'Webhook channel'), superuserOnly: true },
      { ...field('webhook_botname', 'Webhook bot name'), superuserOnly: true },
      field('email', 'Email'),
      phone,
      fax,
      notes,
    ],
  },
  groups: {
    title: 'Groups',
    permission: 'groups',
    fields: [
      name,
      { ...field('permissions', 'Permissions', 'permissions'), superuserOnly: true },
      notes,
    ],
  },
  users: {
    title: 'Users',
    permission: 'users',
    fields: [
      { key: 'username', label: 'Username', required: true },
      field('first_name', 'First name'),
      field('last_name', 'Last name'),
      field('display_name', 'Display name'),
      field('email', 'Email'),
      field('employee_num', 'Employee number'),
      field('jobtitle', 'Job title'),
      phone,
      manager,
      location,
      reference('department_id', 'Department', 'departments'),
      { ...field('company_ids', 'Company memberships', 'ids'), resource: 'companies' },
      {
        ...field('group_ids', 'Group memberships', 'ids'),
        resource: 'groups',
        superuserOnly: true,
      },
      { ...field('permissions', 'Permissions', 'permissions'), superuserOnly: true },
      { ...field('password', 'Password', 'password'), superuserOnly: true },
      { ...field('activated', 'Active account', 'boolean'), superuserOnly: true },
      notes,
    ],
  },
  locations: {
    title: 'Locations',
    permission: 'locations',
    fields: [
      name,
      reference('parent_id', 'Parent location', 'locations'),
      company,
      manager,
      ...address,
      phone,
      notes,
    ],
  },
  departments: {
    title: 'Departments',
    permission: 'departments',
    fields: [name, company, location, manager, phone, fax, notes],
  },
  categories: {
    title: 'Categories',
    permission: 'categories',
    fields: [
      name,
      {
        ...field('category_type', 'Inventory type', 'enum'),
        options: CATEGORY_TYPES,
        required: true,
      },
      field('eula_text', 'EULA text', 'textarea'),
      field('use_default_eula', 'Use default EULA', 'boolean'),
      field('require_acceptance', 'Require acceptance', 'boolean'),
      field('alert_on_response', 'Notify on response', 'boolean'),
      field('checkin_email', 'Email on check-in', 'boolean'),
      notes,
    ],
  },
  manufacturers: {
    title: 'Manufacturers',
    permission: 'manufacturers',
    fields: [
      name,
      field('url', 'Website'),
      field('support_url', 'Support website'),
      field('support_email', 'Support email'),
      field('support_phone', 'Support phone'),
      notes,
    ],
  },
  suppliers: {
    title: 'Suppliers',
    permission: 'suppliers',
    fields: [
      name,
      field('contact', 'Contact'),
      field('email', 'Email'),
      field('url', 'Website'),
      ...address,
      phone,
      fax,
      notes,
    ],
  },
  statuslabels: {
    title: 'Status Labels',
    permission: 'statuslabels',
    fields: [
      name,
      field('color', 'Color'),
      field('deployable', 'Deployable', 'boolean'),
      field('pending', 'Pending', 'boolean'),
      field('archived', 'Archived', 'boolean'),
      field('default_label', 'Default status', 'boolean'),
      field('show_in_nav', 'Show in navigation', 'boolean'),
      notes,
    ],
  },
};

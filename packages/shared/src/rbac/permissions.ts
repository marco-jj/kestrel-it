/**
 * Complete RBAC permission catalog extracted from Snipe-IT config/permissions.php.
 */
export const PERMISSION_GROUPS = {
  Superuser: ['superuser'],
  Admin: ['admin'],
  Import: ['import'],
  Reports: ['reports.view'],
  Assets: [
    'assets.view',
    'assets.create',
    'assets.edit',
    'assets.delete',
    'assets.checkin',
    'assets.checkout',
    'assets.audit',
    'assets.view.encrypted_custom_fields',
    'assets.files',
  ],
  Accessories: [
    'accessories.view',
    'accessories.create',
    'accessories.edit',
    'accessories.delete',
    'accessories.checkout',
    'accessories.checkin',
    'accessories.files',
  ],
  Consumables: [
    'consumables.view',
    'consumables.create',
    'consumables.edit',
    'consumables.delete',
    'consumables.checkout',
    'consumables.files',
  ],
  Licenses: [
    'licenses.view',
    'licenses.create',
    'licenses.edit',
    'licenses.delete',
    'licenses.checkout',
    'licenses.checkin',
    'licenses.keys',
    'licenses.files',
  ],
  Components: [
    'components.view',
    'components.create',
    'components.edit',
    'components.delete',
    'components.checkout',
    'components.checkin',
    'components.files',
  ],
  Kits: ['kits.view', 'kits.create', 'kits.edit', 'kits.delete'],
  Users: ['users.view', 'users.create', 'users.edit', 'users.delete', 'users.files'],
  Models: ['models.view', 'models.create', 'models.edit', 'models.delete', 'models.files'],
  Categories: [
    'categories.view',
    'categories.create',
    'categories.edit',
    'categories.delete',
  ],
  Departments: [
    'departments.view',
    'departments.create',
    'departments.edit',
    'departments.delete',
    'departments.files',
  ],
  'Status Labels': [
    'statuslabels.view',
    'statuslabels.create',
    'statuslabels.edit',
    'statuslabels.delete',
  ],
  'Custom Fields': [
    'customfields.view',
    'customfields.create',
    'customfields.edit',
    'customfields.delete',
  ],
  Suppliers: [
    'suppliers.view',
    'suppliers.create',
    'suppliers.edit',
    'suppliers.delete',
    'suppliers.files',
  ],
  Manufacturers: [
    'manufacturers.view',
    'manufacturers.create',
    'manufacturers.edit',
    'manufacturers.delete',
  ],
  Depreciations: [
    'depreciations.view',
    'depreciations.create',
    'depreciations.edit',
    'depreciations.delete',
  ],
  Locations: [
    'locations.view',
    'locations.create',
    'locations.edit',
    'locations.delete',
    'locations.files',
  ],
  Companies: [
    'companies.view',
    'companies.create',
    'companies.edit',
    'companies.delete',
    'companies.files',
  ],
  'User (Self) Accounts': [
    'self.two_factor',
    'self.api',
    'self.edit_location',
    'self.checkout_assets',
    'self.view_purchase_cost',
    'assets.view.requestable',
  ],
} as const;

export const ALL_PERMISSIONS = [
  ...PERMISSION_GROUPS.Superuser,
  ...PERMISSION_GROUPS.Admin,
  ...PERMISSION_GROUPS.Import,
  ...PERMISSION_GROUPS.Reports,
  ...PERMISSION_GROUPS.Assets,
  ...PERMISSION_GROUPS.Accessories,
  ...PERMISSION_GROUPS.Consumables,
  ...PERMISSION_GROUPS.Licenses,
  ...PERMISSION_GROUPS.Components,
  ...PERMISSION_GROUPS.Kits,
  ...PERMISSION_GROUPS.Users,
  ...PERMISSION_GROUPS.Models,
  ...PERMISSION_GROUPS.Categories,
  ...PERMISSION_GROUPS.Departments,
  ...PERMISSION_GROUPS['Status Labels'],
  ...PERMISSION_GROUPS['Custom Fields'],
  ...PERMISSION_GROUPS.Suppliers,
  ...PERMISSION_GROUPS.Manufacturers,
  ...PERMISSION_GROUPS.Depreciations,
  ...PERMISSION_GROUPS.Locations,
  ...PERMISSION_GROUPS.Companies,
  ...PERMISSION_GROUPS['User (Self) Accounts'],
] as const;

export type PermissionKey = (typeof ALL_PERMISSIONS)[number];

export const CHECKOUT_REQUEST_PERMISSIONS = {
  asset: 'assets.checkout',
  model: 'assets.checkout',
  license: 'licenses.checkout',
  accessory: 'accessories.checkout',
  consumable: 'consumables.checkout',
  component: 'components.checkout',
} as const satisfies Record<string, PermissionKey>;

/**
 * 1 = Grant, 0 = Inherit/Unset, -1 = Explicit Deny (user-level override).
 */
export type PermissionValue = 1 | 0 | -1;

export type PermissionMap = Partial<Record<PermissionKey, PermissionValue>>;

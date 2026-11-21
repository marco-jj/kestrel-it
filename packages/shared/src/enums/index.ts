/**
 * Computed status meta for Assets combining Statuslabel flags and assignment state.
 */
export const STATUS_META_TYPES = [
  'deployable',
  'deployed',
  'pending',
  'archived',
  'undeployable',
] as const;
export type StatusMetaType = (typeof STATUS_META_TYPES)[number];

/**
 * Valid polymorphic checkout targets for an Asset.
 */
export const CHECKOUT_TARGET_TYPES = ['user', 'location', 'asset'] as const;
export type CheckoutTargetType = (typeof CHECKOUT_TARGET_TYPES)[number];

/**
 * Canonical polymorphic item/target types used in action_logs, uploads, and requests.
 */
export const POLYMORPHIC_ITEM_TYPES = [
  'user',
  'asset',
  'location',
  'license',
  'license_seat',
  'accessory',
  'consumable',
  'component',
  'model',
  'company',
  'department',
  'supplier',
  'maintenance',
] as const;
export type PolymorphicItemType = (typeof POLYMORPHIC_ITEM_TYPES)[number];

/**
 * Category classification types.
 */
export const CATEGORY_TYPES = [
  'asset',
  'accessory',
  'consumable',
  'component',
  'license',
] as const;
export type CategoryType = (typeof CATEGORY_TYPES)[number];

/**
 * Action types recorded in the immutable action_logs table.
 */
export const ACTION_TYPES = [
  'checkout',
  'checkin from',
  'create',
  'update',
  'delete',
  'restore',
  'audit',
  'accepted',
  'declined',
  'requested',
  'canceled',
  'uploaded',
  'add seats',
  'remove seats',
  'adjust quantity',
  'maintenance',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * Origin of an audited action.
 */
export const ACTION_SOURCES = ['gui', 'api', 'cli', 'importer', 'oidc_jit'] as const;
export type ActionSource = (typeof ACTION_SOURCES)[number];

/**
 * UI input elements supported by Custom Fields.
 */
export const CUSTOM_FIELD_ELEMENTS = [
  'text',
  'listbox',
  'textarea',
  'markdown-textarea',
  'checkbox',
  'radio',
  'date_picker',
  'datetime_picker',
] as const;
export type CustomFieldElement = (typeof CUSTOM_FIELD_ELEMENTS)[number];

/**
 * Predefined validation format labels supported by Custom Fields.
 */
export const CUSTOM_FIELD_FORMATS = [
  'ANY',
  'CUSTOM REGEX',
  'ALPHA',
  'ALPHA-DASH',
  'NUMERIC',
  'ALPHA-NUMERIC',
  'EMAIL',
  'DATE',
  'DATETIME',
  'URL',
  'IP',
  'IPV4',
  'IPV6',
  'MAC',
  'BOOLEAN',
  'PHONE',
  'FAX',
] as const;
export type CustomFieldFormat = (typeof CUSTOM_FIELD_FORMATS)[number];

/**
 * Global depreciation calculation methods (settings.depreciation_method).
 */
export const DEPRECIATION_METHODS = ['default', 'half_1', 'half_2', 'diminish'] as const;
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];

/**
 * Floor value mode for a Depreciation schedule.
 */
export const DEPRECIATION_TYPES = ['amount', 'percent'] as const;
export type DepreciationType = (typeof DEPRECIATION_TYPES)[number];

/**
 * Lifecycle states for self-service Checkout Requests.
 */
export const CHECKOUT_REQUEST_STATES = ['pending', 'fulfilled', 'canceled'] as const;
export type CheckoutRequestState = (typeof CHECKOUT_REQUEST_STATES)[number];

/**
 * Supported outbound webhook providers.
 */
export const WEBHOOK_PROVIDERS = ['slack', 'general', 'google', 'microsoft'] as const;
export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

/**
 * Supported pluggable storage backends.
 */
export const STORAGE_DRIVERS = ['local', 's3', 'nextcloud'] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

/**
 * Storage bucket categories mapped from Snipe-IT App\Enums\FileStorage.
 */
export const STORAGE_BUCKET_CATEGORIES = [
  'assets',
  'models',
  'licenses',
  'users',
  'locations',
  'companies',
  'departments',
  'suppliers',
  'maintenances',
  'accessories',
  'consumables',
  'components',
  'audits',
  'signatures',
  'eulas',
  'imports',
  'barcodes',
  'branding',
] as const;
export type StorageBucketCategory = (typeof STORAGE_BUCKET_CATEGORIES)[number];

/**
 * Global 2FA policy values (0 = Disabled, 1 = Opt-in, 2 = Required for all).
 */
export const TWO_FACTOR_POLICY = {
  DISABLED: 0,
  OPT_IN: 1,
  REQUIRED: 2,
} as const;
export type TwoFactorPolicy = (typeof TWO_FACTOR_POLICY)[keyof typeof TWO_FACTOR_POLICY];

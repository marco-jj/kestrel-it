import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { validateEnv } from '../config/env.schema.js';
import { DatabaseBootstrapService } from '../db/bootstrap.service.js';
import * as schema from '../db/schema/index.js';
import { HealthController } from '../health/health.controller.js';

describe('Drizzle PostgreSQL schema', () => {
  it('exports all core ITAM, secondary inventory, and operations tables', () => {
    const expectedTableNames = [
      'companies',
      'users',
      'company_user',
      'groups',
      'users_groups',
      'personal_access_tokens',
      'login_attempts',
      'locations',
      'departments',
      'categories',
      'manufacturers',
      'suppliers',
      'status_labels',
      'depreciations',
      'custom_fields',
      'custom_fieldsets',
      'custom_field_custom_fieldset',
      'custom_field_defaults',
      'models',
      'assets',
      'licenses',
      'license_seats',
      'accessories',
      'accessories_checkout',
      'consumables',
      'consumables_users',
      'components',
      'components_assets',
      'kits',
      'kits_models',
      'kits_licenses',
      'kits_consumables',
      'kits_accessories',
      'orders',
      'order_items',
      'action_logs',
      'checkout_acceptances',
      'checkout_requests',
      'maintenance_types',
      'asset_maintenances',
      'calendar_events',
      'imports',
      'report_templates',
      'saved_searches',
      'custom_user_labels',
      'settings',
    ];

    const exportedNames = [
      schema.companies,
      schema.users,
      schema.companyUser,
      schema.groups,
      schema.usersGroups,
      schema.personalAccessTokens,
      schema.loginAttempts,
      schema.locations,
      schema.departments,
      schema.categories,
      schema.manufacturers,
      schema.suppliers,
      schema.statusLabels,
      schema.depreciations,
      schema.customFields,
      schema.customFieldsets,
      schema.customFieldCustomFieldset,
      schema.customFieldDefaults,
      schema.models,
      schema.assets,
      schema.licenses,
      schema.licenseSeats,
      schema.accessories,
      schema.accessoriesCheckout,
      schema.consumables,
      schema.consumablesUsers,
      schema.components,
      schema.componentsAssets,
      schema.kits,
      schema.kitsModels,
      schema.kitsLicenses,
      schema.kitsConsumables,
      schema.kitsAccessories,
      schema.orders,
      schema.orderItems,
      schema.actionLogs,
      schema.checkoutAcceptances,
      schema.checkoutRequests,
      schema.maintenanceTypes,
      schema.assetMaintenances,
      schema.calendarEvents,
      schema.imports,
      schema.reportTemplates,
      schema.savedSearches,
      schema.customUserLabels,
      schema.settings,
    ].map((t) => getTableName(t));

    expect(exportedNames).toEqual(expectedTableNames);
  });

  it('defines JSONB custom_fields on assets and OIDC JIT columns on settings', () => {
    const assetColumns = getTableColumns(schema.assets);
    expect(assetColumns.customFields).toBeDefined();
    expect(assetColumns.customFields.dataType).toBe('json');
    expect(assetColumns.customFields.notNull).toBe(true);

    const settingColumns = getTableColumns(schema.settings);
    expect(settingColumns.oidcAutoProvisionUsers).toBeDefined();
    expect(settingColumns.oidcGroupMapping).toBeDefined();
    expect(settingColumns.fullMultipleCompaniesSupport).toBeDefined();
  });
});

describe('Environment validation & controllers', () => {
  it('parses default env configuration and rejects malformed APP_ENCRYPTION_KEY', () => {
    const valid = validateEnv({});
    expect(valid.API_PORT).toBe(3000);
    expect(valid.STORAGE_DRIVER).toBe('local');
    expect(valid.OIDC_AUTO_PROVISION_USERS).toBe(true);

    expect(() => validateEnv({ APP_ENCRYPTION_KEY: 'too-short' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('returns version and health status', async () => {
    const controller = new HealthController();
    expect(controller.getVersion()).toEqual({
      name: 'Kestrel-IT',
      version: '0.0.2-beta',
      api_version: 'v1',
    });

    const unconfiguredHealth = await controller.getHealth();
    expect(unconfiguredHealth.status).toBe('ok');
    expect(unconfiguredHealth.database).toBe('unconfigured');

    const mockDb = {
      execute: async () => [],
    } as unknown as NonNullable<ConstructorParameters<typeof HealthController>[0]>;
    const connectedHealth = await new HealthController(mockDb).getHealth();
    expect(connectedHealth.status).toBe('ok');
    expect(connectedHealth.database).toBe('up');
  });

  it('validates the signing key at startup when Better Auth is enabled', () => {
    expect(() => validateEnv({ BETTER_AUTH_ENABLED: true })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => validateEnv({ BETTER_AUTH_ENABLED: true, BETTER_AUTH_SECRET: 'too short' }))
      .toThrow(/BETTER_AUTH_SECRET/);
    expect(validateEnv({
      BETTER_AUTH_ENABLED: true,
      BETTER_AUTH_SECRET: 'long-test-key-for-better-auth-validation',
    }).BETTER_AUTH_ENABLED).toBe(true);
  });

  it('requires deployment-specific signing and encryption keys in production', () => {
    expect(() => validateEnv({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET.*APP_ENCRYPTION_KEY/);
    expect(() => validateEnv({
      NODE_ENV: 'production',
      JWT_SECRET: 'test-production-signing-key-for-validation',
      APP_ENCRYPTION_KEY: 'a1'.repeat(32),
    })).not.toThrow();
  });

  it('evaluates setup completion status accurately', async () => {
    const makeMockDb = (userCount: number, settingsCount: number) => {
      let callIndex = 0;
      return {
        select: () => ({
          from: async () => {
            callIndex += 1;
            return [{ total: callIndex === 1 ? userCount : settingsCount }];
          },
        }),
      } as unknown as ConstructorParameters<typeof DatabaseBootstrapService>[0];
    };

    const configMock = { get: () => '' } as unknown as ConstructorParameters<
      typeof DatabaseBootstrapService
    >[1];

    expect(await new DatabaseBootstrapService(makeMockDb(0, 0), configMock).isSetupCompleted()).toBe(
      false,
    );
    expect(await new DatabaseBootstrapService(makeMockDb(1, 0), configMock).isSetupCompleted()).toBe(
      false,
    );
    expect(await new DatabaseBootstrapService(makeMockDb(1, 1), configMock).isSetupCompleted()).toBe(
      true,
    );
  });
});

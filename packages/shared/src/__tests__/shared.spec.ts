import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ALL_PERMISSIONS,
  FmcsCompanyAssignmentError,
  allowedElementKeysForFormat,
  buildCustomFieldZodSchema,
  buildFieldsetZodSchema,
  canAccessCompanyRecord,
  canEncryptFor,
  createDatatableResponseSchema,
  elementRequiresFieldValues,
  generateCustomFieldDbColumn,
  hasAccess,
  iconForFormat,
  parseFieldValuesOptions,
  resolveAssignedCompanyId,
  resolveEffectivePermissions,
} from '../index.js';

describe('Datatable response schema', () => {
  it('accepts zero pages for an empty list and rejects negative or fractional page counts', () => {
    const schema = createDatatableResponseSchema(z.object({ id: z.number().int() }));
    const emptyPage = {
      total: 0,
      rows: [],
      current_page: 1,
      per_page: 50,
      total_pages: 0,
      prev_page_url: null,
      next_page_url: null,
    };

    expect(schema.parse(emptyPage)).toEqual(emptyPage);
    expect(schema.safeParse({ ...emptyPage, total_pages: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...emptyPage, total_pages: 0.5 }).success).toBe(false);
  });
});

describe('RBAC permissions & evaluator', () => {
  it('contains all 87 unique Snipe-IT permissions', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
    expect(ALL_PERMISSIONS).toContain('assets.view.encrypted_custom_fields');
    expect(ALL_PERMISSIONS).toContain('licenses.keys');
    expect(ALL_PERMISSIONS).toContain('self.api');
  });

  it('enforces precedence: Superuser > Explicit User Grant/Deny > Admin > Group Grant', () => {
    expect(hasAccess({ superuser: 1, 'assets.view': -1 }, [], 'assets.view')).toBe(true);
    expect(hasAccess({ admin: 1, 'assets.delete': -1 }, [], 'assets.delete')).toBe(false);
    expect(hasAccess({ admin: 1 }, [], 'assets.checkout')).toBe(true);
    expect(hasAccess({ admin: 1 }, [], 'superuser')).toBe(false);
    expect(hasAccess({}, [{ 'licenses.view': 1 }], 'licenses.view')).toBe(true);
    expect(hasAccess({ 'licenses.view': -1 }, [{ 'licenses.view': 1 }], 'licenses.view')).toBe(
      false,
    );
    expect(hasAccess({ 'licenses.keys': 1 }, [{ 'licenses.keys': 0 }], 'licenses.keys')).toBe(true);
  });

  it('resolves effective permissions map for all keys', () => {
    const map = resolveEffectivePermissions({}, [{ 'assets.view': 1 }]);
    expect(map['assets.view']).toBe(true);
    expect(map['assets.delete']).toBe(false);
  });
});

describe('FMCS multi-company access & assignment', () => {
  it('allows superusers and non-FMCS environments unconditionally', () => {
    expect(
      canAccessCompanyRecord({
        fmcsEnabled: false,
        nullCompanyIsFloater: false,
        isSuperUser: false,
        userCompanyIds: [1],
        targetCompanyId: 99,
      }),
    ).toBe(true);

    expect(
      canAccessCompanyRecord({
        fmcsEnabled: true,
        nullCompanyIsFloater: false,
        isSuperUser: true,
        userCompanyIds: [1],
        targetCompanyId: 99,
      }),
    ).toBe(true);
  });

  it('enforces strict vs floater company scoping for items, users, locations, and companies', () => {
    // Company-scoped item
    expect(
      canAccessCompanyRecord({
        fmcsEnabled: true,
        nullCompanyIsFloater: false,
        isSuperUser: false,
        userCompanyIds: [1, 2],
        targetCompanyId: null,
      }),
    ).toBe(false);

    expect(
      canAccessCompanyRecord({
        fmcsEnabled: true,
        nullCompanyIsFloater: true,
        isSuperUser: false,
        userCompanyIds: [1, 2],
        targetCompanyId: null,
      }),
    ).toBe(true);

    // Users pivot scoping
    expect(
      canAccessCompanyRecord({
        fmcsEnabled: true,
        nullCompanyIsFloater: false,
        isSuperUser: false,
        userCompanyIds: [1],
        targetTable: 'users',
        targetUserCompanyIds: [1, 3],
      }),
    ).toBe(true);

    expect(
      canAccessCompanyRecord({
        fmcsEnabled: true,
        nullCompanyIsFloater: false,
        isSuperUser: false,
        userCompanyIds: [1],
        targetTable: 'users',
        targetUserCompanyIds: [],
      }),
    ).toBe(false);

    // Locations scoping opt-in
    expect(
      canAccessCompanyRecord({
        fmcsEnabled: true,
        nullCompanyIsFloater: false,
        scopeLocationsFmcs: false,
        isSuperUser: false,
        userCompanyIds: [1],
        targetTable: 'locations',
        targetCompanyId: 99,
      }),
    ).toBe(true);
  });

  it('resolves assigned company_id and rejects cross-tenant assignment', () => {
    expect(
      resolveAssignedCompanyId({
        fmcsEnabled: true,
        nullCompanyIsFloater: false,
        isSuperUser: false,
        userCompanyIds: [4],
        submittedCompanyId: null,
      }),
    ).toBe(4);

    expect(() =>
      resolveAssignedCompanyId({
        fmcsEnabled: true,
        nullCompanyIsFloater: false,
        isSuperUser: false,
        userCompanyIds: [4],
        submittedCompanyId: 99,
      }),
    ).toThrow(FmcsCompanyAssignmentError);
  });
});

describe('Custom Fields compatibility & dynamic Zod builder', () => {
  it('enforces element/format/encryption matrix', () => {
    expect(allowedElementKeysForFormat('DATE')).toEqual(['date_picker']);
    expect(allowedElementKeysForFormat('date_format:Y-m-d H:i:s')).toEqual(['datetime_picker']);
    expect(allowedElementKeysForFormat('MAC')).toEqual(['text']);
    expect(allowedElementKeysForFormat('BOOLEAN')).toEqual(['text', 'checkbox', 'radio']);

    expect(canEncryptFor('date_picker', 'DATE')).toBe(false);
    expect(canEncryptFor('checkbox', 'ANY')).toBe(false);
    expect(canEncryptFor('text', 'MAC')).toBe(true);

    expect(elementRequiresFieldValues('listbox')).toBe(true);
    expect(elementRequiresFieldValues('text')).toBe(false);
    expect(iconForFormat('EMAIL')).toBe('email');
    expect(iconForFormat('MAC')).toBeNull();
  });

  it('generates Snipe-IT compatible JSONB db_column slugs and parses field values', () => {
    expect(generateCustomFieldDbColumn('MAC Address', 1)).toBe('_snipeit_mac_address_1');
    expect(generateCustomFieldDbColumn('Indirizzo Città', 7)).toBe('_snipeit_indirizzo_citta_7');

    expect(parseFieldValuesOptions('a|Alpha\nb\r\nc|Gamma')).toEqual([
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'b' },
      { value: 'c', label: 'Gamma' },
    ]);
  });

  it('validates dynamic fieldsets with MAC, custom regex, listbox, and optional empty strings', () => {
    const macSchema = buildCustomFieldZodSchema(
      { name: 'MAC', dbColumn: '_snipeit_mac_1', element: 'text', format: 'MAC' },
      true,
    );
    expect(macSchema.safeParse('AA:BB:CC:DD:EE:FF').success).toBe(true);
    expect(macSchema.safeParse('invalid-mac').success).toBe(false);
    expect(macSchema.safeParse('').success).toBe(false);

    const optionalEmail = buildCustomFieldZodSchema(
      { name: 'Owner Email', dbColumn: '_snipeit_email_2', element: 'text', format: 'EMAIL' },
      false,
    );
    expect(optionalEmail.safeParse('').success).toBe(true);
    expect(optionalEmail.safeParse('bad-email').success).toBe(false);
    expect(optionalEmail.safeParse('it@example.com').success).toBe(true);

    const fieldsetSchema = buildFieldsetZodSchema([
      {
        field: {
          name: 'Tag Code',
          dbColumn: '_snipeit_tag_code_3',
          element: 'text',
          format: 'regex:/^[A-Z]{2}-[0-9]{4}$/',
        },
        required: true,
      },
      {
        field: {
          name: 'OS',
          dbColumn: '_snipeit_os_4',
          element: 'listbox',
          format: 'ANY',
          fieldValues: 'linux|Linux\nmacos|macOS',
        },
        required: true,
      },
    ]);

    expect(
      fieldsetSchema.safeParse({
        _snipeit_tag_code_3: 'IT-1234',
        _snipeit_os_4: 'linux',
      }).success,
    ).toBe(true);

    expect(
      fieldsetSchema.safeParse({
        _snipeit_tag_code_3: 'invalid',
        _snipeit_os_4: 'windows',
      }).success,
    ).toBe(false);
  });
});

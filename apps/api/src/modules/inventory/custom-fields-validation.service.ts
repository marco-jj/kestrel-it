import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import {
  buildCustomFieldZodSchema,
  normalizeFormatLabel,
  CustomFieldValuesSchema,
  type AuthenticatedUserContext,
  type CustomFieldFormMode,
  type InventoryCustomField,
} from '@kestrel-it/shared';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { Worker } from 'node:worker_threads';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import { permitsKey } from '../../common/guards/permissions.guard.js';
import {
  assets,
  customFieldCustomFieldset,
  customFieldDefaults,
  customFields,
} from '../../db/schema/index.js';
import { parse, type InventoryDatabase, type InventoryTransaction } from './inventory-queries.js';

type Field = typeof customFields.$inferSelect;
export type FieldsetEntry = { field: Field; required: boolean };
type Values = Record<string, unknown>;

export function fieldIssue(key: string, message: string): never {
  throw new UnprocessableEntityException({
    status: 'error',
    messages: { [key]: [message] },
    payload: null,
  });
}

export function pattern(format: string) {
  const raw = format.slice('regex:'.length);
  const parts = /^\/(.*)\/([gimsuy]*)$/.exec(raw);
  const source = parts?.[1] ?? raw;
  const flags = parts?.[2] ?? '';
  return new RegExp(source, flags);
}

async function checkPattern(regex: RegExp, value: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const { source, flags, value } = workerData;
      parentPort.postMessage(new RegExp(source, flags).test(value));
    `,
      {
        eval: true,
        workerData: { source: regex.source, flags: regex.flags, value },
        resourceLimits: { maxOldGenerationSizeMb: 16, stackSizeMb: 2 },
      },
    );
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve(false);
    }, 350);
    const finish = (result: boolean) => {
      clearTimeout(timer);
      resolve(result);
    };
    worker.once('message', (result: unknown) => finish(result === true));
    worker.once('error', () => finish(false));
    worker.once('exit', () => finish(false));
  });
}

function usesMode(field: Field, mode: CustomFieldFormMode) {
  if (mode === 'checkout') return field.displayCheckout;
  if (mode === 'checkin') return field.displayCheckin;
  if (mode === 'audit') return field.displayAudit;
  return true;
}

function present(value: unknown) {
  return (
    value !== null &&
    value !== undefined &&
    value !== '' &&
    (!Array.isArray(value) || value.length > 0)
  );
}

@Injectable()
export class CustomFieldsValidationService {
  constructor(@Inject(CryptoService) private readonly crypto: CryptoService) {}

  async fields(db: InventoryDatabase, fieldsetId: number | null): Promise<FieldsetEntry[]> {
    if (fieldsetId === null) return [];
    return db
      .select({ field: customFields, required: customFieldCustomFieldset.required })
      .from(customFieldCustomFieldset)
      .innerJoin(customFields, eq(customFields.id, customFieldCustomFieldset.customFieldId))
      .where(eq(customFieldCustomFieldset.customFieldsetId, fieldsetId))
      .orderBy(customFieldCustomFieldset.order, customFields.id);
  }

  describe(entries: FieldsetEntry[], mode: CustomFieldFormMode): InventoryCustomField[] {
    return entries
      .filter(({ field }) => usesMode(field, mode))
      .map(({ field, required }) => ({
        id: field.id,
        name: field.name,
        element: field.element,
        format: field.format,
        db_column: field.dbColumn,
        field_values: field.fieldValues,
        help_text: field.helpText,
        field_encrypted: field.fieldEncrypted,
        required,
      }));
  }

  async prepare(
    tx: InventoryTransaction,
    input: {
      entries: FieldsetEntry[];
      submitted?: Values;
      existing?: Values;
      applyDefaultsFrom?: number;
      revalidateExisting?: boolean;
      assetId?: number;
      mode?: CustomFieldFormMode;
    },
  ): Promise<Values> {
    const mode = input.mode ?? 'asset';
    const active = input.entries.filter(({ field }) => usesMode(field, mode));
    const keys = new Set(active.map(({ field }) => field.dbColumn));
    const submitted = parse(CustomFieldValuesSchema, input.submitted ?? {});
    for (const key of Object.keys(submitted)) {
      if (!keys.has(key)) fieldIssue(key, 'This field is unavailable for this operation');
    }
    const defaults =
      input.applyDefaultsFrom === undefined
        ? []
        : await tx
            .select()
            .from(customFieldDefaults)
            .where(eq(customFieldDefaults.modelId, input.applyDefaultsFrom));
    const defaultValues = new Map(defaults.map((row) => [row.customFieldId, row.defaultValue]));
    const saved = Object.fromEntries(
      input.entries
        .filter(({ field }) => Object.hasOwn(input.existing ?? {}, field.dbColumn))
        .map(({ field }) => [field.dbColumn, input.existing![field.dbColumn]]),
    );
    for (const { field, required } of active) {
      const hasInput = Object.hasOwn(submitted, field.dbColumn);
      if (!hasInput && Object.hasOwn(saved, field.dbColumn)) {
        if (!input.revalidateExisting) continue;
        const existing = this.decode(field, saved[field.dbColumn]);
        if (present(existing)) {
          await this.validateValue(field, existing, required);
          continue;
        }
      }
      const value = hasInput
        ? submitted[field.dbColumn]
        : this.decodeDefault(field, defaultValues.get(field.id) ?? null);
      const validated = await this.validateValue(field, value, required);
      if (!present(validated)) {
        delete saved[field.dbColumn];
        continue;
      }
      await this.assertUnique(tx, field, validated, input.assetId);
      saved[field.dbColumn] = this.encode(field, validated);
    }
    return saved;
  }

  async checkRestore(
    tx: InventoryTransaction,
    entries: FieldsetEntry[],
    saved: Values,
    id: number,
  ) {
    for (const { field, required } of entries) {
      const value = this.decode(field, saved[field.dbColumn]);
      await this.validateValue(field, value, required);
      if (present(value)) await this.assertUnique(tx, field, value, id);
    }
  }

  async validateValue(field: Field, value: unknown, required: boolean): Promise<unknown> {
    const format = normalizeFormatLabel(field.format);
    const custom = format.startsWith('regex:');
    const validator = buildCustomFieldZodSchema(
      custom ? { ...field, format: 'ANY' } : field,
      required,
    );
    const validation = validator.safeParse(value);
    if (!validation.success)
      fieldIssue(field.dbColumn, validation.error.issues[0]?.message ?? 'Invalid value');
    if (custom && present(validation.data)) {
      let regex: RegExp;
      try {
        regex = pattern(format);
      } catch {
        fieldIssue(field.dbColumn, 'Invalid custom regex');
      }
      if (typeof validation.data !== 'string' || !(await checkPattern(regex, validation.data))) {
        fieldIssue(
          field.dbColumn,
          'Value does not match the custom pattern within its validation limit',
        );
      }
    }
    if (
      format === 'URL' &&
      present(validation.data) &&
      !/^https?:\/\//i.test(String(validation.data))
    ) {
      fieldIssue(field.dbColumn, 'Enter an HTTP or HTTPS URL');
    }
    if (
      (format === 'DATE' || format === 'DATETIME') &&
      typeof validation.data === 'string' &&
      validation.data
    ) {
      const timestamp =
        format === 'DATE'
          ? validation.data + 'T00:00:00Z'
          : validation.data.replace(' ', 'T') + 'Z';
      const date = new Date(timestamp);
      if (
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 19) !== timestamp.slice(0, 19)
      ) {
        fieldIssue(field.dbColumn, 'Enter a valid calendar date and time');
      }
    }
    return validation.data;
  }

  private async assertUnique(tx: InventoryTransaction, field: Field, value: unknown, id?: number) {
    if (!field.isUnique) return;
    const valueText = this.comparisonValue(value);
    const column = sql`${assets.customFields} -> ${field.dbColumn}`;
    const scope = and(isNull(assets.deletedAt), id === undefined ? undefined : ne(assets.id, id));
    if (!field.fieldEncrypted) {
      const [existing] = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(
            scope,
            sql`(${column} = ${JSON.stringify(value)}::jsonb OR (${column} #>> '{}') = ${valueText})`,
          ),
        )
        .limit(1);
      if (existing) fieldIssue(field.dbColumn, 'This value is already in use');
      return;
    }
    // Legacy encrypted values have random IVs, so equality must compare the decoded values.
    // The inventory write lock also covers uniqueness checks made by concurrent writers.
    const matches = await tx
      .select({ value: column })
      .from(assets)
      .where(and(scope, sql`jsonb_exists(${assets.customFields}, ${field.dbColumn})`));
    if (
      matches.some((entry) => this.comparisonValue(this.decode(field, entry.value)) === valueText)
    ) {
      fieldIssue(field.dbColumn, 'This value is already in use');
    }
  }

  private comparisonValue(value: unknown) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      return String(value);
    return JSON.stringify(value);
  }

  encode(field: Field, value: unknown): unknown {
    if (!present(value)) return null;
    return field.fieldEncrypted ? this.crypto.encrypt(JSON.stringify(value)) : value;
  }

  decode(field: Field, value: unknown): unknown {
    if (!field.fieldEncrypted || value == null) return value;
    if (typeof value !== 'string')
      throw new Error('Encrypted custom field has invalid storage format');
    const plaintext = this.crypto.decrypt(value);
    try {
      return JSON.parse(plaintext);
    } catch {
      return plaintext;
    }
  }

  decodeDefault(field: Field, value: string | null): unknown {
    if (value === null || field.fieldEncrypted) return this.decode(field, value);
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  serialize(
    entries: FieldsetEntry[],
    values: Values,
    user: AuthenticatedUserContext,
    audience: 'inventory' | 'request' | 'email' = 'inventory',
  ) {
    const visible = permitsKey(user, 'assets.view.encrypted_custom_fields');
    return Object.fromEntries(
      entries
        .filter(
          ({ field }) =>
            audience === 'inventory' ||
            (!field.fieldEncrypted &&
              (audience === 'request' ? field.showInRequestableList : field.showInEmail)),
        )
        .map(({ field }) => [
          field.name,
          {
            field: field.dbColumn,
            element: field.element,
            field_format: normalizeFormatLabel(field.format),
            value:
              field.fieldEncrypted && !visible
                ? 'ENCRYPTED'
                : (this.decode(field, values[field.dbColumn]) ?? null),
          },
        ]),
    );
  }
}

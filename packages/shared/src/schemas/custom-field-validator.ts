import { z } from 'zod';
import {
  CUSTOM_FIELD_ELEMENTS,
  type CustomFieldElement,
  type CustomFieldFormat,
} from '../enums/index.js';

export const PREDEFINED_FORMAT_PATTERNS: Record<CustomFieldFormat, string> = {
  ANY: '',
  'CUSTOM REGEX': '',
  ALPHA: 'alpha',
  'ALPHA-DASH': 'alpha_dash',
  NUMERIC: 'numeric',
  'ALPHA-NUMERIC': 'alpha_num',
  EMAIL: 'email',
  DATE: 'date',
  DATETIME: 'date_format:Y-m-d H:i:s',
  URL: 'url',
  IP: 'ip',
  IPV4: 'ipv4',
  IPV6: 'ipv6',
  MAC: 'regex:/^[a-fA-F0-9]{2}:[a-fA-F0-9]{2}:[a-fA-F0-9]{2}:[a-fA-F0-9]{2}:[a-fA-F0-9]{2}:[a-fA-F0-9]{2}$/',
  BOOLEAN: 'boolean',
  PHONE: 'string',
  FAX: 'present',
};

export const TEXT_ONLY_FORMATS: readonly CustomFieldFormat[] = [
  'EMAIL',
  'URL',
  'PHONE',
  'FAX',
  'MAC',
  'IP',
  'IPV4',
  'IPV6',
  'ALPHA',
  'ALPHA-DASH',
  'ALPHA-NUMERIC',
  'NUMERIC',
];

/**
 * Reverse-maps stored Laravel-style format strings (e.g. 'date_format:Y-m-d H:i:s')
 * back to their canonical friendly format label (e.g. 'DATETIME').
 */
export function normalizeFormatLabel(format?: string | null): string {
  if (!format) {
    return 'ANY';
  }
  for (const [label, pattern] of Object.entries(PREDEFINED_FORMAT_PATTERNS)) {
    if (format === label || (pattern !== '' && format === pattern)) {
      return label;
    }
  }
  return format;
}

/**
 * Returns the UI element keys compatible with the given format label.
 * Mirrors CustomField::allowedElementKeysForFormat() in Snipe-IT.
 */
export function allowedElementKeysForFormat(formatLabel?: string | null): CustomFieldElement[] {
  const normalized = normalizeFormatLabel(formatLabel);

  if (normalized === 'DATE') {
    return ['date_picker'];
  }
  if (normalized === 'DATETIME') {
    return ['datetime_picker'];
  }
  if (normalized === 'CUSTOM REGEX' || normalized.startsWith('regex:')) {
    return ['text'];
  }
  if ((TEXT_ONLY_FORMATS as readonly string[]).includes(normalized)) {
    return ['text'];
  }
  if (normalized === 'BOOLEAN') {
    return ['text', 'checkbox', 'radio'];
  }

  return [...CUSTOM_FIELD_ELEMENTS];
}

/**
 * Returns whether encryption is allowed for a given element/format combination.
 * DATE/DATETIME and checkbox/radio elements cannot be encrypted.
 */
export function canEncryptFor(
  element?: CustomFieldElement | null,
  formatLabel?: string | null,
): boolean {
  const normalized = normalizeFormatLabel(formatLabel);
  if (normalized === 'DATE' || normalized === 'DATETIME') {
    return false;
  }
  if (element === 'checkbox' || element === 'radio') {
    return false;
  }
  return true;
}

/**
 * Returns whether the element requires a non-empty field_values option list.
 */
export function elementRequiresFieldValues(element?: CustomFieldElement | null): boolean {
  return element === 'listbox' || element === 'checkbox' || element === 'radio';
}

/**
 * Returns the decorative icon identifier for a given format label, or null.
 */
export function iconForFormat(
  formatLabel?: string | null,
): 'email' | 'link' | 'phone' | 'fax' | null {
  switch (normalizeFormatLabel(formatLabel)) {
    case 'EMAIL':
      return 'email';
    case 'URL':
      return 'link';
    case 'PHONE':
      return 'phone';
    case 'FAX':
      return 'fax';
    default:
      return null;
  }
}

/**
 * Generates the stable Snipe-IT-compatible db_column slug (`_snipeit_<slug>_<id>`),
 * used as the key inside PostgreSQL assets.custom_fields JSONB.
 */
export function generateCustomFieldDbColumn(name: string, id: number | string = 'xx'): string {
  const asciiSlug = name
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const prefixed = `_snipeit_${asciiSlug}`;
  return `${prefixed.slice(0, 50)}_${id}`;
}

export interface FieldValueOption {
  value: string;
  label: string;
}

/**
 * Parses newline-delimited field_values (supporting optional `value|label` syntax).
 */
export function parseFieldValuesOptions(fieldValues?: string | null): FieldValueOption[] {
  if (!fieldValues) {
    return [];
  }

  const options: FieldValueOption[] = [];
  const lines = fieldValues.split(/\r\n|\r|\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const pipeIndex = line.indexOf('|');
    if (pipeIndex !== -1) {
      const value = line.slice(0, pipeIndex).trim();
      const label = line.slice(pipeIndex + 1).trim();
      if (value !== '') {
        options.push({ value, label: label || value });
      }
    } else {
      options.push({ value: line, label: line });
    }
  }

  return options;
}

export interface CustomFieldDefinition {
  id?: number;
  name: string;
  dbColumn: string;
  element: CustomFieldElement;
  format?: string | null;
  fieldValues?: string | null;
  fieldEncrypted?: boolean;
  isUnique?: boolean;
}

function buildFormatBaseSchema(format?: string | null): z.ZodTypeAny {
  const normalized = normalizeFormatLabel(format);

  switch (normalized) {
    case 'EMAIL':
      return z.string().email('Must be a valid email address');
    case 'URL':
      return z.string().url('Must be a valid URL');
    case 'NUMERIC':
      return z.union([
        z.number(),
        z.string().regex(/^-?\d+(\.\d+)?$/, 'Must be a valid numeric value'),
      ]);
    case 'ALPHA':
      return z.string().regex(/^[a-zA-Z]+$/, 'Must contain only alphabetic characters');
    case 'ALPHA-DASH':
      return z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/, 'Must contain only letters, numbers, dashes, or underscores');
    case 'ALPHA-NUMERIC':
      return z.string().regex(/^[a-zA-Z0-9]+$/, 'Must contain only letters and numbers');
    case 'MAC':
      return z
        .string()
        .regex(
          /^[a-fA-F0-9]{2}:[a-fA-F0-9]{2}:[a-fA-F0-9]{2}:[a-fA-F0-9]{2}:[a-fA-F0-9]{2}:[a-fA-F0-9]{2}$/,
          'Must be a valid MAC address (XX:XX:XX:XX:XX:XX)',
        );
    case 'DATE':
      return z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a valid YYYY-MM-DD date');
    case 'DATETIME':
      return z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'Must be a valid YYYY-MM-DD HH:mm:ss datetime');
    case 'IPV4':
      return z.string().ip({ version: 'v4', message: 'Must be a valid IPv4 address' });
    case 'IPV6':
      return z.string().ip({ version: 'v6', message: 'Must be a valid IPv6 address' });
    case 'IP':
      return z.string().ip({ message: 'Must be a valid IP address' });
    case 'BOOLEAN':
      return z.union([z.boolean(), z.enum(['0', '1', 'true', 'false'])]);
    case 'PHONE':
    case 'FAX':
    case 'ANY':
    case 'CUSTOM REGEX':
      return z.string();
    default: {
      if (normalized.startsWith('regex:')) {
        const match = /^regex:\/(.*)\/([gimsuy]*)$/.exec(normalized);
        try {
          const regex = match
            ? new RegExp(match[1]!, match[2])
            : new RegExp(normalized.replace(/^regex:/, ''));
          return z.string().regex(regex, 'Value does not match custom pattern');
        } catch {
          return z.string().refine(() => false, { message: 'Invalid custom regex pattern' });
        }
      }
      return z.string();
    }
  }
}

/**
 * Builds a dynamic Zod schema for validating a single Custom Field value in assets.custom_fields JSONB.
 */
export function buildCustomFieldZodSchema(
  field: CustomFieldDefinition,
  isRequiredInFieldset: boolean,
): z.ZodTypeAny {
  const options = parseFieldValuesOptions(field.fieldValues);
  const allowedValues = options.map((o) => o.value);
  const formatSchema = buildFormatBaseSchema(field.format);

  let valueSchema: z.ZodTypeAny;

  if (field.element === 'checkbox') {
    const checkItem = (item: string) =>
      allowedValues.length === 0 || allowedValues.includes(item);

    const baseCheckbox = z
      .union([
        z.array(z.string()),
        z.string().transform((val) =>
          val
            .split(',')
            .map((v) => v.trim())
            .filter((v) => v.length > 0),
        ),
      ])
      .refine((items) => items.every(checkItem), {
        message: 'Contains an invalid option for this checkbox field',
      });

    valueSchema = isRequiredInFieldset
      ? baseCheckbox.refine((items) => items.length > 0, {
          message: `${field.name} is required`,
        })
      : z.union([baseCheckbox, z.literal(''), z.null()]).optional();

    return valueSchema;
  }

  if ((field.element === 'listbox' || field.element === 'radio') && allowedValues.length > 0) {
    valueSchema = z.string().refine((val) => allowedValues.includes(val), {
      message: `Must be one of the configured options for ${field.name}`,
    });
  } else {
    valueSchema = formatSchema;
  }

  if (isRequiredInFieldset) {
    return valueSchema.refine(
      (val) => val !== undefined && val !== null && String(val).trim().length > 0,
      { message: `${field.name} is required` },
    );
  }

  return z.union([valueSchema, z.literal(''), z.null()]).optional();
}

/**
 * Builds a Zod object schema validating all fields belonging to a CustomFieldset,
 * keyed by each field's `dbColumn` (`_snipeit_<slug>_<id>`).
 */
export function buildFieldsetZodSchema(
  fields: Array<{ field: CustomFieldDefinition; required: boolean }>,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const entry of fields) {
    shape[entry.field.dbColumn] = buildCustomFieldZodSchema(entry.field, entry.required);
  }
  return z.object(shape);
}

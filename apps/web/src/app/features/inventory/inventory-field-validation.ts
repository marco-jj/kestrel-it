import { Validators, type ValidatorFn } from '@angular/forms';
import { LocalPasswordSchema } from '@kestrel-it/shared';
import { validateFieldSchema } from '../../shared/ui/field-validation.js';
import type { InventoryField } from './directory-ui.js';

export const phonePattern = '\\+?[0-9]+';

export const inventoryFormatErrors = {
  email: 'Enter a valid email address.',
  tel: 'Enter digits with an optional leading +.',
  url: 'Enter a complete URL starting with http:// or https://.',
} as const;

const formatValidators: Partial<Record<NonNullable<InventoryField['type']>, ValidatorFn>> = {
  email: Validators.email,
  tel: Validators.pattern(phonePattern),
  password: (control) => control.value ? validatePassword(control) : null,
  url: (control) => {
    if (!control.value) return null;
    const url = URL.parse(control.value);
    return url && ['http:', 'https:'].includes(url.protocol) && /^https?:\/\//i.test(control.value)
      ? null
      : { url: true };
  },
};
const validatePassword = validateFieldSchema(LocalPasswordSchema);

export function inventoryFieldValidators(field: InventoryField, existingValue?: unknown): ValidatorFn[] {
  const validators: ValidatorFn[] = field.required ? [(control) => {
    if (typeof control.value === 'string' && field.type !== 'password' && !control.value.trim()) {
      return { required: true };
    }
    return Validators.required(control);
  }] : [];
  const format = field.type ? formatValidators[field.type] : undefined;
  if (format) validators.push((control) => control.value === existingValue ? null : format(control));
  return validators;
}

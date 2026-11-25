import { Component, Input } from '@angular/core';
import type { AbstractControl, ValidatorFn } from '@angular/forms';
import type { ZodType } from 'zod';

export function validateFieldSchema(schema: ZodType): ValidatorFn {
  return ({ value }) => {
    const result = schema.safeParse(value);
    if (result.success) return null;
    const issue = result.error.issues[0];
    if (issue?.code === 'too_small' && issue.origin === 'string') {
      return issue.minimum === 1 ? { required: true } : { minlength: { requiredLength: issue.minimum } };
    }
    if (issue?.code === 'too_big' && issue.origin === 'string') {
      return { maxlength: { requiredLength: issue.maximum } };
    }
    if (issue?.code === 'invalid_format' && issue.format === 'email') return { email: true };
    return { format: issue?.message ?? 'Enter a valid value.' };
  };
}

export function fieldValidationMessage(
  control: AbstractControl | null | undefined,
  requiredLabel?: string,
): string | null {
  if (requiredLabel && control?.hasError('required')) return `${requiredLabel} is required.`;
  if (!control || !(control.dirty || control.touched)) return null;
  const errors = control.errors;
  if (!errors) return null;
  if (errors['required']) return 'This field is required.';
  if (errors['minlength']) return `Use at least ${errors['minlength'].requiredLength} characters.`;
  if (errors['maxlength']) return `Use at most ${errors['maxlength'].requiredLength} characters.`;
  if (errors['email']) return 'Enter a valid email address.';
  if (errors['pattern']) return 'Enter digits with an optional leading +.';
  if (errors['url']) return 'Enter a complete URL starting with http:// or https://.';
  return errors['format'] ?? null;
}

@Component({
  selector: 'kestrel-field-error',
  standalone: true,
  template: `
    <small class="k-field-error" [id]="errorId" aria-live="polite">{{ message(control, requiredLabel) }}</small>
  `,
})
export class FieldErrorComponent {
  @Input() control?: AbstractControl | null;
  @Input() errorId?: string;
  @Input() requiredLabel?: string;
  readonly message = fieldValidationMessage;
}

import { ApiBody, type SchemaObject } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export function requestBodySchema(schema: ZodTypeAny): SchemaObject {
  return zodToJsonSchema(schema, {
    target: 'openApi3',
    $refStrategy: 'none',
    pipeStrategy: 'input',
    removeAdditionalStrategy: 'strict',
    applyRegexFlags: true,
  }) as SchemaObject;
}

export function ApiZodBody(schema: ZodTypeAny, required = true) {
  return ApiBody({ schema: requestBodySchema(schema), required });
}

import { ApiBody, type SchemaObject } from '@nestjs/swagger';
import { z, type ZodTypeAny } from 'zod';

export function requestBodySchema(schema: ZodTypeAny): SchemaObject {
  return z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'input' }) as SchemaObject;
}

export function ApiZodBody(schema: ZodTypeAny, required = true) {
  return ApiBody({ schema: requestBodySchema(schema), required });
}

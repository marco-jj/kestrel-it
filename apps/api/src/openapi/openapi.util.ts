import {
  CORE_INVENTORY_RESOURCES,
  KIT_RESOURCES,
  REPORT_TYPES,
  REQUESTABLE_TYPES,
} from '@kestrel-it/shared';
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

type PathItem = Record<string, any>;

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;

const PARAM_ENUMS: Array<{ pathMatch: string; param: string; values: readonly string[] }> = [
  { pathMatch: '/account/requestable/{type}', param: 'type', values: REQUESTABLE_TYPES },
  {
    pathMatch: '/account/request/{type}/{id}',
    param: 'type',
    values: ['models', 'licenses', 'accessories', 'consumables', 'components'],
  },
  {
    pathMatch: '/account/request/{type}/{id}/cancel',
    param: 'type',
    values: ['models', 'licenses', 'accessories', 'consumables', 'components'],
  },
  { pathMatch: '/reports/{type}', param: 'type', values: REPORT_TYPES },
  { pathMatch: '/kits/{id}/{kind}', param: 'kind', values: KIT_RESOURCES },
  { pathMatch: '/hardware/targets/{type}', param: 'type', values: ['user', 'location', 'asset'] },
  { pathMatch: '/hardware/{action}/{status}', param: 'action', values: ['audit', 'audits', 'checkins'] },
  {
    pathMatch: '/hardware/{action}/{status}',
    param: 'status',
    values: ['due', 'overdue', 'due-or-overdue'],
  },
  { pathMatch: '/account/accept/{id}/{artifact}', param: 'artifact', values: ['eula', 'signature'] },
];

function cloneOperation(op: Record<string, any>, resource: string): Record<string, any> {
  const cloned = structuredClone(op);
  if (Array.isArray(cloned.parameters)) {
    cloned.parameters = cloned.parameters.filter(
      (parameter: { name?: string; in?: string }) =>
        !(parameter.in === 'path' && parameter.name === 'resource'),
    );
  }
  cloned.tags = ['Directory & Taxonomy'];
  if (!cloned.summary && cloned.operationId) {
    cloned.summary = `${cloned.operationId} (${resource})`;
  }
  if (cloned.operationId) {
    cloned.operationId = `${cloned.operationId}_${resource}`;
  }
  return cloned;
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Kestrel-IT API')
    .setDescription('Cloud-native IT Asset Management (ITAM) REST API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  const paths: Record<string, PathItem> = {};

  for (const [pathKey, pathItem] of Object.entries(document.paths ?? {})) {
    if (pathKey.includes('/{resource}')) {
      for (const resource of CORE_INVENTORY_RESOURCES) {
        if (resource === 'groups' && pathKey.endsWith('/restore')) continue;
        const concretePath = pathKey.replace('/{resource}', `/${resource}`);
        const targetItem = (paths[concretePath] ??= {});
        for (const method of HTTP_METHODS) {
          if (pathItem[method]) {
            targetItem[method] = cloneOperation(pathItem[method], resource);
          }
        }
      }
      continue;
    }

    const clonedItem: PathItem = structuredClone(pathItem);
    for (const rule of PARAM_ENUMS) {
      if (!pathKey.endsWith(rule.pathMatch)) continue;
      for (const method of HTTP_METHODS) {
        const op = clonedItem[method];
        if (!op || !Array.isArray(op.parameters)) continue;
        for (const parameter of op.parameters) {
          if (parameter.in === 'path' && parameter.name === rule.param) {
            parameter.schema = { type: 'string', enum: [...rule.values] };
          }
        }
      }
    }
    paths[pathKey] = clonedItem;
  }

  document.paths = Object.fromEntries(
    Object.entries(paths).sort(([left], [right]) => left.localeCompare(right)),
  );
  return document;
}

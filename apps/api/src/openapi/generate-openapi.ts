import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppModule } from '../app.module.js';
import { buildOpenApiDocument } from './openapi.util.js';

const defaultOut = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/openapi.json',
);

async function main() {
  const outputPath = resolve(process.argv[2] || defaultOut);
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger: false },
  );
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
  const document = buildOpenApiDocument(app);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await app.close();
  console.log(
    `Exported ${Object.keys(document.paths ?? {}).length} OpenAPI paths to ${outputPath}`,
  );
}

await main();

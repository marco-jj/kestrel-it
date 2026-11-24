import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppModule } from '../app.module.js';
import { buildOpenApiDocument } from './openapi.util.js';

const defaultOut = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/openapi.json',
);

async function main() {
  const check = process.argv[2] === '--check';
  const outputPath = resolve(process.argv[check ? 3 : 2] || defaultOut);
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger: false },
  );
  try {
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
    const document = buildOpenApiDocument(app);
    const generated = `${JSON.stringify(document, null, 2)}\n`;
    if (check) {
      if (await readFile(outputPath, 'utf8') !== generated) {
        throw new Error('OpenAPI contract is out of date. Run pnpm --filter @kestrel-it/api openapi:export.');
      }
      console.log(`OpenAPI contract is up to date at ${outputPath}`);
    } else {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, generated, 'utf8');
      console.log(`Exported ${Object.keys(document.paths).length} OpenAPI paths to ${outputPath}`);
    }
  } finally {
    await app.close();
  }
}

await main();

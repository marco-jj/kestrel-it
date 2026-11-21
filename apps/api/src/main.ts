import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import type { EnvConfig } from './config/env.schema.js';
import { DatabaseBootstrapService } from './db/bootstrap.service.js';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart);

  const configService = app.get<ConfigService<EnvConfig, true>>(ConfigService);
  const apiPrefix = configService.get('API_PREFIX', { infer: true });
  const port = configService.get('API_PORT', { infer: true });

  app.setGlobalPrefix(apiPrefix, { exclude: ['health'] });
  app.enableCors({
    origin: configService.get('APP_URL', { infer: true }),
    credentials: true,
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Kestrel-IT API')
    .setDescription('Cloud-native IT Asset Management (ITAM) REST API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  try {
    const bootstrapService = app.get(DatabaseBootstrapService);
    await bootstrapService.runHeadlessBootstrapIfConfigured();
  } catch (error) {
    logger.warn(
      `Skipping startup database bootstrap (PostgreSQL may not be ready yet): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  await app.listen(port, '0.0.0.0');
  logger.log(`Kestrel-IT API listening on http://0.0.0.0:${port}/${apiPrefix}`);
}

void bootstrap();

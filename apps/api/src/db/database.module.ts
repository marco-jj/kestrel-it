import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import type { EnvConfig } from '../config/env.schema.js';
import { DatabaseBootstrapService } from './bootstrap.service.js';
import { DRIZZLE_DB, POSTGRES_CLIENT, type DrizzleDb } from './database.tokens.js';
import * as schema from './schema/index.js';

export { DRIZZLE_DB, POSTGRES_CLIENT, type DrizzleDb } from './database.tokens.js';

@Global()
@Module({
  providers: [
    {
      provide: POSTGRES_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>): Sql => {
        const databaseUrl = config.get('DATABASE_URL', { infer: true });
        return postgres(databaseUrl, {
          max: 20,
          idle_timeout: 20,
          connect_timeout: 10,
        });
      },
    },
    {
      provide: DRIZZLE_DB,
      inject: [POSTGRES_CLIENT],
      useFactory: (client: Sql): DrizzleDb => {
        return drizzle(client, { schema });
      },
    },
    DatabaseBootstrapService,
  ],
  exports: [DRIZZLE_DB, DatabaseBootstrapService],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(POSTGRES_CLIENT) private readonly client: Sql) {}

  async onModuleDestroy(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}

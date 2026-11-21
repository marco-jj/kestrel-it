import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { Public } from '../common/decorators/auth.decorators.js';
import { DRIZZLE_DB, type DrizzleDb } from '../db/database.module.js';

@ApiTags('System')
@Controller()
export class HealthController {
  constructor(@Optional() @Inject(DRIZZLE_DB) private readonly db?: DrizzleDb) {}

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Health check endpoint for Kubernetes probes' })
  async getHealth() {
    let database: 'up' | 'down' | 'unconfigured' = 'unconfigured';

    if (this.db) {
      try {
        await this.db.execute(sql`SELECT 1`);
        database = 'up';
      } catch {
        database = 'down';
      }
    }

    return {
      status: database === 'down' ? 'degraded' : 'ok',
      database,
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Get('version')
  @ApiOperation({ summary: 'Application version metadata' })
  getVersion() {
    return {
      name: 'Kestrel-IT',
      version: '0.1.0',
      api_version: 'v1',
    };
  }
}

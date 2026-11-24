import { Controller, Get, Inject, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { Public } from '../common/decorators/auth.decorators.js';
import { DatabaseBootstrapService } from '../db/bootstrap.service.js';
import { DRIZZLE_DB, type DrizzleDb } from '../db/database.module.js';

@ApiTags('System')
@Controller()
export class HealthController {
  constructor(
    @Optional() @Inject(DRIZZLE_DB) private readonly db?: DrizzleDb,
    @Optional() @Inject(DatabaseBootstrapService)
    private readonly bootstrapService?: DatabaseBootstrapService,
  ) {}

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
  @Get('ready')
  @ApiOperation({ summary: 'Readiness check for serving API traffic' })
  async getReadiness() {
    try {
      if (!this.bootstrapService) throw new Error('Database is unconfigured');
      await this.bootstrapService.checkSchema();
    } catch {
      throw new ServiceUnavailableException('Database schema is not ready');
    }
    return { status: 'ok' };
  }

  @Public()
  @Get('version')
  @ApiOperation({ summary: 'Application version metadata' })
  getVersion() {
    return {
      name: 'Kestrel-IT',
      version: '0.0.2-beta',
      api_version: 'v1',
    };
  }
}

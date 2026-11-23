import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  InventoryIdSchema,
  SavedSearchInputSchema,
  type AuthenticatedUserContext,
} from '@kestrel-it/shared';
import { and, eq } from 'drizzle-orm';
import { CurrentUser, RequirePermission } from '../../common/decorators/auth.decorators.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import { savedSearches } from '../../db/schema/index.js';
import { HardwareService } from './hardware.service.js';
import { parse, success } from './inventory-queries.js';

@Controller('saved-searches')
@RequirePermission('assets.view')
export class SavedSearchesController {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(HardwareService) private readonly hardware: HardwareService,
  ) {}

  private own(user: AuthenticatedUserContext, id?: number) {
    return and(
      eq(savedSearches.createdBy, user.id),
      eq(savedSearches.tableName, 'hardware'),
      id === undefined ? undefined : eq(savedSearches.id, id),
    );
  }

  private serialize(row: typeof savedSearches.$inferSelect) {
    try {
      const result = SavedSearchInputSchema.safeParse({
        name: row.name,
        query: JSON.parse(row.queryString),
      });
      if (result.success) return { id: row.id, ...result.data };
    } catch {
      /* Legacy queries may have been stored as URL query strings. */
    }
    const result = SavedSearchInputSchema.safeParse({
      name: row.name,
      query: Object.fromEntries(new URLSearchParams(row.queryString)),
    });
    return { id: row.id, name: row.name, query: result.success ? result.data.query : {} };
  }

  @Get()
  async list(@CurrentUser() user: AuthenticatedUserContext) {
    const rows = await this.db
      .select()
      .from(savedSearches)
      .where(this.own(user))
      .orderBy(savedSearches.name, savedSearches.id);
    return { total: rows.length, rows: rows.map((row) => this.serialize(row)) };
  }

  @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUserContext) {
    const [row] = await this.db
      .select()
      .from(savedSearches)
      .where(this.own(user, parse(InventoryIdSchema, id)))
      .limit(1);
    if (!row) throw new NotFoundException('Saved search not found');
    return this.serialize(row);
  }

  @Post()
  async create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    const { name, query } = parse(SavedSearchInputSchema, body);
    await this.hardware.validateCustomFilter(query.custom_field, query.custom_value);
    const [row] = await this.db
      .insert(savedSearches)
      .values({
        createdBy: user.id,
        tableName: 'hardware',
        name,
        queryString: JSON.stringify(query),
      })
      .returning();
    return success(this.serialize(row!));
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    const { name, query } = parse(SavedSearchInputSchema.partial(), body);
    if (query) await this.hardware.validateCustomFilter(query.custom_field, query.custom_value);
    const [row] = await this.db
      .update(savedSearches)
      .set({
        name,
        queryString: query ? JSON.stringify(query) : undefined,
        updatedAt: new Date(),
      })
      .where(this.own(user, parse(InventoryIdSchema, id)))
      .returning();
    if (!row) throw new NotFoundException('Saved search not found');
    return success(this.serialize(row));
  }

  @Put(':id')
  replace(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.update(id, body, user);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUserContext) {
    const [row] = await this.db
      .delete(savedSearches)
      .where(this.own(user, parse(InventoryIdSchema, id)))
      .returning();
    if (!row) throw new NotFoundException('Saved search not found');
    return success({ id: row.id });
  }
}

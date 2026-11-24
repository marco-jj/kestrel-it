import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  DatatableQuerySchema,
  DEPRECIATION_METHODS,
  InventoryIdSchema,
  inventoryMoney,
  inventoryName,
  type AuthenticatedUserContext,
} from '@kestrel-it/shared';
import { asc, eq } from 'drizzle-orm';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, RequirePermission } from '../../common/decorators/auth.decorators.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import { depreciations, licenses, models, settings } from '../../db/schema/index.js';
import { fieldIssue } from './custom-fields-validation.service.js';
import { contains, inventoryWrite, parse, success } from './inventory-queries.js';
import { currentSettings, inventoryPage } from './phase-three-queries.js';
import { ApiZodBody } from '../../openapi/request-body.js';

const schema = z.object({
  name: inventoryName,
  months: z.coerce.number().int().min(1).max(1200),
  depreciation_min: inventoryMoney.nullable().optional(),
  depreciation_type: z.enum(['amount', 'percent']).optional(),
  fiscal_year_start_month: z.coerce.number().int().min(1).max(12).optional(),
  rate_multiplier: inventoryMoney
    .refine((rate) => Number(rate) > 0 && Number(rate) <= 999.99)
    .nullable()
    .optional(),
});
const id = (value: string) => parse(InventoryIdSchema, value);
const settingsInput = z.object({ depreciation_method: z.enum(DEPRECIATION_METHODS) }).strict();
const fields = {
  id: depreciations.id,
  name: depreciations.name,
  months: depreciations.months,
  depreciation_min: depreciations.depreciationMin,
  depreciation_type: depreciations.depreciationType,
  fiscal_year_start_month: depreciations.fiscalYearStartMonth,
  rate_multiplier: depreciations.rateMultiplier,
};

@ApiTags('Depreciations')
@ApiBearerAuth()
@Controller('depreciations')
export class DepreciationController {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  @Get('settings')
  async getSettings(@CurrentUser() user: AuthenticatedUserContext) {
    this.requireSuperuser(user);
    const config = await currentSettings(this.db);
    if (!config) throw new NotFoundException('Settings not found');
    return success({ depreciation_method: config.depreciationMethod ?? 'default' });
  }

  @ApiZodBody(settingsInput)
  @Patch('settings')
  updateSettings(@Body() raw: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    this.requireSuperuser(user);
    const { depreciation_method } = parse(settingsInput, raw);
    return inventoryWrite(this.db, async (tx) => {
      const config = await currentSettings(tx);
      if (!config) throw new NotFoundException('Settings not found');
      await tx
        .update(settings)
        .set({ depreciationMethod: depreciation_method, updatedAt: new Date() })
        .where(eq(settings.id, config.id));
      return success({ depreciation_method });
    });
  }

  private requireSuperuser(user: AuthenticatedUserContext) {
    if (!user.isSuperUser)
      throw new ForbiddenException('Only superusers can configure the global depreciation method');
  }

  @Get()
  @RequirePermission('depreciations.view')
  list(@Query() raw: unknown, @Req() req: { url: string }) {
    const query = parse(DatatableQuerySchema, raw);
    return inventoryPage(
      this.db,
      depreciations,
      fields,
      query.search ? contains(depreciations.name, query.search) : undefined,
      [asc(depreciations.name), asc(depreciations.id)],
      query,
      req.url,
    );
  }

  @Get(':id')
  @RequirePermission('depreciations.view')
  async get(@Param('id') value: string) {
    const [row] = await this.db
      .select(fields)
      .from(depreciations)
      .where(eq(depreciations.id, id(value)));
    if (!row) throw new NotFoundException('Depreciation schedule not found');
    return row;
  }

  @ApiZodBody(schema)
  @Post()
  @RequirePermission('depreciations.create')
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    return this.save(body, user.id);
  }

  @ApiZodBody(schema.partial())
  @Patch(':id')
  @RequirePermission('depreciations.edit')
  update(
    @Param('id') value: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.save(body, user.id, id(value));
  }

  @ApiZodBody(schema.partial())
  @Put(':id')
  @RequirePermission('depreciations.edit')
  replace(
    @Param('id') value: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.update(value, body, user);
  }

  @Delete(':id')
  @RequirePermission('depreciations.delete')
  remove(@Param('id') value: string) {
    const schedule = id(value);
    return inventoryWrite(this.db, async (tx) => {
      const [model] = await tx
        .select({ id: models.id })
        .from(models)
        .where(eq(models.depreciationId, schedule))
        .limit(1);
      const [license] = await tx
        .select({ id: licenses.id })
        .from(licenses)
        .where(eq(licenses.depreciationId, schedule))
        .limit(1);
      if (model || license) throw new ConflictException('Depreciation schedule is in use');
      const [row] = await tx
        .delete(depreciations)
        .where(eq(depreciations.id, schedule))
        .returning({ id: depreciations.id });
      if (!row) throw new NotFoundException('Depreciation schedule not found');
      return success(row);
    });
  }

  private save(body: unknown, actor: number, key?: number) {
    const dto = parse(key === undefined ? schema : schema.partial(), body);
    return inventoryWrite(this.db, async (tx) => {
      const [previous] =
        key === undefined
          ? []
          : await tx.select().from(depreciations).where(eq(depreciations.id, key)).for('update');
      if (key !== undefined && !previous)
        throw new NotFoundException('Depreciation schedule not found');
      const type = dto.depreciation_type ?? previous?.depreciationType ?? 'amount';
      const floor =
        dto.depreciation_min === undefined ? previous?.depreciationMin : dto.depreciation_min;
      if (type === 'percent' && Number(floor) > 100)
        fieldIssue('depreciation_min', 'Percent floor cannot exceed 100');
      const data = {
        name: dto.name ?? previous!.name,
        months: dto.months ?? previous!.months,
        depreciationType: type,
        depreciationMin: floor,
        fiscalYearStartMonth: dto.fiscal_year_start_month,
        rateMultiplier: dto.rate_multiplier,
        updatedAt: new Date(),
      };
      const [row] =
        key === undefined
          ? await tx
              .insert(depreciations)
              .values({ ...data, createdBy: actor })
              .returning(fields)
          : await tx
              .update(depreciations)
              .set(data)
              .where(eq(depreciations.id, key))
              .returning(fields);
      return success(row!);
    });
  }
}

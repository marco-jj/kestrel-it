import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AssetInputSchema,
  AssetModelInputSchema,
  InventoryBulkSchema,
  CustomFieldFormModeSchema,
  DatatableQuerySchema,
  HardwareQuerySchema,
  InventoryIdSchema,
  SelectlistQuerySchema,
  type AuthenticatedUserContext,
} from '@kestrel-it/shared';
import { z } from 'zod';
import { CurrentUser, RequirePermission } from '../../common/decorators/auth.decorators.js';
import { permitsEntity, permitsKey } from '../../common/guards/permissions.guard.js';
import { AssetModelsService } from './asset-models.service.js';
import { HardwareService } from './hardware.service.js';
import { parse } from './inventory-queries.js';
import { ApiZodBody } from '../../openapi/request-body.js';

const tagSchema = z.string().min(1).max(255);
const modelCloneSchema = z.object({ name: z.string().trim().min(1).max(255) }).strict();
const modelQuery = DatatableQuerySchema.extend({ deleted: z.enum(['0', '1']).optional() });

@ApiTags('Hardware')
@ApiBearerAuth()
@Controller('hardware')
export class HardwareController {
  constructor(@Inject(HardwareService) private readonly hardware: HardwareService) {}

  @Get()
  @RequirePermission('assets.view')
  list(
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.hardware.list(parse(HardwareQuerySchema, query), user, req.url);
  }

  @Get('selectlist')
  options(@Query() query: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    if (!permitsEntity(user, 'assets.view') && user.keyPermissions?.['assets.checkout'] !== true) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return this.hardware.options(parse(SelectlistQuerySchema, query), user);
  }

  @Get('custom-filter-fields')
  @RequirePermission('assets.view')
  customFilters(@Query() query: unknown) {
    return this.hardware.customFilterOptions(parse(SelectlistQuerySchema, query));
  }

  @Get('form/:modelId')
  form(
    @Param('modelId') modelId: string,
    @Query('mode') mode: string | undefined,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    if (
      !(mode === 'audit' && permitsKey(user, 'assets.audit')) &&
      !['view', 'create', 'edit', 'checkout', 'checkin'].some((action) =>
        permitsEntity(user, `assets.${action}` as 'assets.view'),
      )
    )
      throw new ForbiddenException('Insufficient permissions');
    return this.hardware.form(
      parse(InventoryIdSchema, modelId),
      parse(CustomFieldFormModeSchema, mode ?? 'asset'),
      user,
    );
  }

  @Get(':id')
  @RequirePermission('assets.view')
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUserContext) {
    return this.hardware.get(parse(InventoryIdSchema, id), user);
  }

  @Get('bytag/:tag')
  @RequirePermission('assets.view')
  getByTag(@Param('tag') tag: string, @CurrentUser() user: AuthenticatedUserContext) {
    return this.hardware.get(parse(tagSchema, tag), user);
  }

  @Get('byserial/:serial')
  @RequirePermission('assets.view')
  getBySerial(
    @Param('serial') serial: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.hardware.list(
      { ...parse(HardwareQuerySchema, query), serial: parse(tagSchema, serial) },
      user,
      req.url,
    );
  }

  @Get(':id/history')
  @RequirePermission('assets.view')
  @ApiOperation({ summary: 'List immutable action log history for a hardware asset' })
  history(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.hardware.history(
      'asset',
      parse(InventoryIdSchema, id),
      parse(HardwareQuerySchema, query),
      user,
      req.url,
    );
  }

  @Get(':id/licenses')
  @RequirePermission('assets.view')
  @ApiOperation({ summary: 'List licenses assigned to a hardware asset' })
  licenses(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.hardware.assignedLicenses(
      parse(InventoryIdSchema, id),
      parse(HardwareQuerySchema, query),
      user,
      req.url,
    );
  }

  @Get(':id/assigned/assets')
  @RequirePermission('assets.view')
  @ApiOperation({ summary: 'List child assets checked out to a hardware asset' })
  assignedAssets(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.hardware.assignedAssets(
      parse(InventoryIdSchema, id),
      parse(HardwareQuerySchema, query),
      user,
      req.url,
    );
  }

  @Get(':id/assigned/accessories')
  @RequirePermission('assets.view')
  @ApiOperation({ summary: 'List accessories checked out to a hardware asset (suppresses rows without accessories.view)' })
  assignedAccessories(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.hardware.assignedAccessories(
      parse(InventoryIdSchema, id),
      parse(HardwareQuerySchema, query),
      user,
      req.url,
    );
  }

  @Get(':id/assigned/components')
  @RequirePermission('assets.view')
  @ApiOperation({ summary: 'List components checked out to a hardware asset (suppresses rows without components.view)' })
  assignedComponents(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.hardware.assignedComponents(
      parse(InventoryIdSchema, id),
      parse(HardwareQuerySchema, query),
      user,
      req.url,
    );
  }

  @ApiZodBody(AssetInputSchema)
  @Post()
  @RequirePermission('assets.create')
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    return this.hardware.save(body, user);
  }

  @ApiZodBody(InventoryBulkSchema)
  @Patch('bulk')
  bulk(@Body() body: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    return this.hardware.bulk(body, user);
  }

  @ApiZodBody(AssetInputSchema.partial())
  @Patch(':id')
  @RequirePermission('assets.edit')
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.hardware.save(body, user, parse(InventoryIdSchema, id));
  }

  @ApiZodBody(AssetInputSchema.partial())
  @Put(':id')
  @RequirePermission('assets.edit')
  replace(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.update(id, body, user);
  }

  @Delete(':id')
  @RequirePermission('assets.delete')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUserContext) {
    return this.hardware.bulk({ action: 'delete', ids: [parse(InventoryIdSchema, id)] }, user);
  }

  @Post(':id/restore')
  @RequirePermission('assets.delete')
  restore(@Param('id') id: string, @CurrentUser() user: AuthenticatedUserContext) {
    return this.hardware.bulk({ action: 'restore', ids: [parse(InventoryIdSchema, id)] }, user);
  }
}

@ApiTags('Asset Models')
@ApiBearerAuth()
@Controller('models')
export class AssetModelsController {
  constructor(
    @Inject(AssetModelsService) private readonly models: AssetModelsService,
    @Inject(HardwareService) private readonly hardware: HardwareService,
  ) {}

  @Get()
  @RequirePermission('models.view')
  list(
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    const filters = parse(modelQuery, query);
    if (filters.deleted === '1' && !permitsEntity(user, 'models.delete'))
      throw new ForbiddenException('Insufficient permissions');
    return this.models.list(filters, user, req.url);
  }

  @Get('selectlist')
  options(@Query() query: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    if (
      !(['models.view', 'assets.view', 'assets.create', 'assets.edit'] as const).some(
        (permission) => permitsEntity(user, permission),
      )
    ) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return this.models.options(parse(SelectlistQuerySchema, query));
  }

  @Get(':id')
  @RequirePermission('models.view')
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUserContext) {
    return this.models.get(parse(InventoryIdSchema, id), user);
  }

  @Get(':id/assets')
  @RequirePermission('models.view', 'assets.view')
  assets(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.hardware.list(
      parse(HardwareQuerySchema, query),
      user,
      req.url,
      parse(InventoryIdSchema, id),
    );
  }

  @Get(':id/history')
  @RequirePermission('models.view')
  history(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.hardware.history(
      'model',
      parse(InventoryIdSchema, id),
      parse(HardwareQuerySchema, query),
      user,
      req.url,
    );
  }

  @ApiZodBody(AssetModelInputSchema)
  @Post()
  @RequirePermission('models.create')
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    return this.models.save(body, user);
  }

  @ApiZodBody(AssetModelInputSchema.partial())
  @Patch(':id')
  @RequirePermission('models.edit')
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.models.save(body, user, parse(InventoryIdSchema, id));
  }

  @ApiZodBody(AssetModelInputSchema.partial())
  @Put(':id')
  @RequirePermission('models.edit')
  replace(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.update(id, body, user);
  }

  @ApiZodBody(modelCloneSchema)
  @Post(':id/clone')
  @RequirePermission('models.view', 'models.create')
  clone(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    const { name } = parse(modelCloneSchema, body);
    return this.models.clone(parse(InventoryIdSchema, id), name, user);
  }

  @Delete(':id')
  @RequirePermission('models.delete')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUserContext) {
    return this.models.changeDeleted(parse(InventoryIdSchema, id), false, user);
  }

  @Post(':id/restore')
  @RequirePermission('models.delete')
  restore(@Param('id') id: string, @CurrentUser() user: AuthenticatedUserContext) {
    return this.models.changeDeleted(parse(InventoryIdSchema, id), true, user);
  }
}

@ApiTags('Depreciations')
@ApiBearerAuth()
@Controller('depreciations')
export class DepreciationSelectorController {
  constructor(@Inject(AssetModelsService) private readonly models: AssetModelsService) {}

  @Get('selectlist')
  options(@Query() query: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    if (
      !(['depreciations.view', 'models.view', 'models.create', 'models.edit'] as const).some(
        (permission) => permitsEntity(user, permission),
      )
    )
      throw new ForbiddenException('Insufficient permissions');
    return this.models.options(parse(SelectlistQuerySchema, query), true);
  }
}

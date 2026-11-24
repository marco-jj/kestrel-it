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
import {
  DatatableQuerySchema,
  InventoryIdSchema,
  KIT_RESOURCES,
  SelectlistQuerySchema,
  type AuthenticatedUserContext,
} from '@kestrel-it/shared';
import { z } from 'zod';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { permitsKey } from '../../common/guards/permissions.guard.js';
import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import { DirectoryService } from './directory.service.js';
import { requireInventoryPermission } from './phase-three-queries.js';
import { parse } from './inventory-queries.js';
import { PredefinedKitsService } from './predefined-kits.service.js';

const id = (value: string) => parse(InventoryIdSchema, value);
const kind = (value: string) => parse(z.enum(KIT_RESOURCES), value);

@ApiTags('Predefined Kits')
@ApiBearerAuth()
@Controller('kits')
export class PredefinedKitsController {
  constructor(
    @Inject(PredefinedKitsService) private readonly kits: PredefinedKitsService,
    @Inject(DirectoryService) private readonly directory: DirectoryService,
  ) {}

  @Get('targets/users')
  options(@Query() raw: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    requireInventoryPermission(user, 'kits.view');
    if (
      !(
        [
          'assets.checkout',
          'licenses.checkout',
          'accessories.checkout',
          'consumables.checkout',
        ] as const
      ).some((permission) => permitsKey(user, permission))
    )
      throw new ForbiddenException('Checkout permission required');
    return this.directory.options('users', parse(SelectlistQuerySchema, raw), user, true);
  }

  @Get()
  list(
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.kits.list(parse(DatatableQuerySchema, query), user, req.url);
  }

  @Get(':id')
  get(@Param('id') value: string, @CurrentUser() user: AuthenticatedUserContext) {
    return this.kits.get(id(value), user);
  }

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    return this.kits.save(body, user);
  }

  @Patch(':id')
  update(
    @Param('id') value: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.kits.save(body, user, id(value));
  }

  @Put(':id')
  replace(
    @Param('id') value: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.update(value, body, user);
  }

  @Delete(':id')
  remove(@Param('id') value: string, @CurrentUser() user: AuthenticatedUserContext) {
    return this.kits.remove(id(value), user);
  }

  @Get(':id/:kind')
  lines(
    @Param('id') value: string,
    @Param('kind') type: string,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.kits.lines(id(value), kind(type), user);
  }

  @Post(':id/:kind')
  add(
    @Param('id') value: string,
    @Param('kind') type: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.kits.changeLine(id(value), kind(type), user, 'add', body);
  }

  @Put(':id/:kind/:item')
  updateLine(
    @Param('id') value: string,
    @Param('kind') type: string,
    @Param('item') item: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.kits.changeLine(id(value), kind(type), user, 'update', body, id(item));
  }

  @Delete(':id/:kind/:item')
  deleteLine(
    @Param('id') value: string,
    @Param('kind') type: string,
    @Param('item') item: string,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.kits.changeLine(id(value), kind(type), user, 'delete', undefined, id(item));
  }

  @Post(':id/checkout')
  checkout(
    @Param('id') value: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.kits.checkout(id(value), body, user);
  }
}

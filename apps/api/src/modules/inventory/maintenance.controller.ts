import {
  Body,
  Controller,
  Delete,
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
  SelectlistQuerySchema,
  type AuthenticatedUserContext,
} from '@kestrel-it/shared';
import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import { parse } from './inventory-queries.js';
import { MaintenanceQuery, MaintenanceService } from './maintenance.service.js';

const id = (value: string) => parse(InventoryIdSchema, value);

@Controller('maintenances')
export class MaintenanceController {
  constructor(@Inject(MaintenanceService) private readonly maintenances: MaintenanceService) {}

  @Get()
  list(
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.maintenances.list(
      parse(DatatableQuerySchema.merge(MaintenanceQuery), query),
      user,
      req.url,
    );
  }

  @Get(':id')
  get(@Param('id') value: string, @CurrentUser() user: AuthenticatedUserContext) {
    return this.maintenances.get(id(value), user);
  }

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    return this.maintenances.save(body, user);
  }

  @Patch(':id')
  update(
    @Param('id') value: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.maintenances.save(body, user, id(value));
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
    return this.maintenances.change(id(value), 'delete', {}, user);
  }

  @Post(':id/complete')
  complete(
    @Param('id') value: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.maintenances.change(id(value), 'complete', body, user);
  }

  @Get(':id/history')
  history(
    @Param('id') value: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.maintenances.history(id(value), parse(DatatableQuerySchema, query), user, req.url);
  }

  @Get(':id/notes')
  notes(
    @Param('id') value: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.maintenances.history(
      id(value),
      parse(DatatableQuerySchema, query),
      user,
      req.url,
      true,
    );
  }

  @Post(':id/notes')
  addNote(
    @Param('id') value: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.maintenances.change(id(value), 'note added', body, user);
  }
}

@Controller('maintenance-types')
export class MaintenanceTypesController {
  constructor(@Inject(MaintenanceService) private readonly maintenances: MaintenanceService) {}

  @Get()
  list(
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.maintenances.typeList(parse(DatatableQuerySchema, query), user, req.url);
  }

  @Get('selectlist')
  options(@Query() query: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    return this.maintenances.typeOptions(parse(SelectlistQuerySchema, query), user);
  }

  @Get(':id')
  get(@Param('id') value: string, @CurrentUser() user: AuthenticatedUserContext) {
    return this.maintenances.readType(id(value), user);
  }

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    return this.maintenances.saveType(body, user);
  }

  @Patch(':id')
  update(
    @Param('id') value: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.maintenances.saveType(body, user, id(value));
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
    return this.maintenances.saveType(undefined, user, id(value), true);
  }
}

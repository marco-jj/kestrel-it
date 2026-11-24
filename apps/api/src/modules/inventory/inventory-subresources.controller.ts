import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  DatatableQuerySchema,
  InventoryIdSchema,
  type AuthenticatedUserContext,
} from '@kestrel-it/shared';
import { CurrentUser, RequirePermission } from '../../common/decorators/auth.decorators.js';
import { parse } from './inventory-queries.js';
import { InventorySubresourcesService } from './inventory-subresources.service.js';

@ApiTags('Inventory Subresources')
@ApiBearerAuth()
@Controller()
export class InventorySubresourcesController {
  constructor(
    @Inject(InventorySubresourcesService) private readonly subresources: InventorySubresourcesService,
  ) {}

  @Get('account/assets')
  @ApiOperation({ summary: 'Return assigned hardware, licenses, accessories, and consumables for the signed-in user' })
  accountAssets(
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.subresources.accountSummary(parse(DatatableQuerySchema, query), user, req.url);
  }

  @Get('users/:id/assets')
  @RequirePermission('users.view')
  @ApiOperation({ summary: 'List hardware assets assigned to a user (FMCS and assets.view scoped)' })
  userAssets(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.subresources.userAssets(parse(InventoryIdSchema, id), parse(DatatableQuerySchema, query), user, req.url);
  }

  @Get('users/:id/accessories')
  @RequirePermission('users.view')
  @ApiOperation({ summary: 'List accessories checked out to a user' })
  userAccessories(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.subresources.userAccessories(parse(InventoryIdSchema, id), parse(DatatableQuerySchema, query), user, req.url);
  }

  @Get('users/:id/consumables')
  @RequirePermission('users.view')
  @ApiOperation({ summary: 'List consumables checked out to a user' })
  userConsumables(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.subresources.userConsumables(parse(InventoryIdSchema, id), parse(DatatableQuerySchema, query), user, req.url);
  }

  @Get('users/:id/licenses')
  @RequirePermission('users.view')
  @ApiOperation({ summary: 'List licenses assigned to a user (masks keys without licenses.keys)' })
  userLicenses(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.subresources.userLicenses(parse(InventoryIdSchema, id), parse(DatatableQuerySchema, query), user, req.url);
  }

  @Get('users/:id/eulas')
  @RequirePermission('users.view')
  @ApiOperation({ summary: 'List checkout acceptances and signed EULAs for a user' })
  userEulas(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.subresources.userEulas(parse(InventoryIdSchema, id), parse(DatatableQuerySchema, query), user, req.url);
  }

  @Get('users/:id/history')
  @RequirePermission('users.view')
  @ApiOperation({ summary: 'List action log entries associated with a user' })
  userHistory(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.subresources.userHistory(parse(InventoryIdSchema, id), parse(DatatableQuerySchema, query), user, req.url);
  }

  @Get('locations/:id/assets')
  @RequirePermission('locations.view', 'assets.view')
  @ApiOperation({ summary: 'List hardware assets currently located at or RTD-homed to a location' })
  locationAssets(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.subresources.locationAssets(parse(InventoryIdSchema, id), parse(DatatableQuerySchema, query), user, req.url);
  }

  @Get('locations/:id/assigned/accessories')
  @RequirePermission('locations.view')
  @ApiOperation({ summary: 'List accessories checked out directly to a location' })
  locationAccessories(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.subresources.locationAccessories(parse(InventoryIdSchema, id), parse(DatatableQuerySchema, query), user, req.url);
  }

  @Get('locations/:id/assigned/components')
  @RequirePermission('locations.view')
  @ApiOperation({ summary: 'List components installed on assets currently at a location' })
  locationComponents(
    @Param('id') id: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.subresources.locationComponents(parse(InventoryIdSchema, id), parse(DatatableQuerySchema, query), user, req.url);
  }

  @Get('statuslabels/assets/name')
  @RequirePermission('statuslabels.view', 'assets.view')
  @ApiOperation({ summary: 'Summarize FMCS-scoped hardware asset counts grouped by status label' })
  statusByName(@CurrentUser() user: AuthenticatedUserContext) {
    return this.subresources.statusCountsByName(user);
  }

  @Get('statuslabels/assets/type')
  @RequirePermission('statuslabels.view', 'assets.view')
  @ApiOperation({ summary: 'Summarize FMCS-scoped hardware asset counts grouped by status meta type' })
  statusByType(@CurrentUser() user: AuthenticatedUserContext) {
    return this.subresources.statusCountsByType(user);
  }

  @Get('statuslabels/:id/deployable')
  @RequirePermission('statuslabels.view')
  @ApiOperation({ summary: 'Return deployability flags for a status label' })
  statusDeployable(@Param('id') id: string) {
    return this.subresources.statusDeployable(parse(InventoryIdSchema, id));
  }
}

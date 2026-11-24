import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  DatatableQuerySchema,
  InventoryIdSchema,
  RequestableTypeSchema,
  SelectlistQuerySchema,
  type AuthenticatedUserContext,
  type RequestableType,
} from '@kestrel-it/shared';
import { z } from 'zod';
import { CurrentUser, RequireKeyPermission } from '../../common/decorators/auth.decorators.js';
import { permitsKey } from '../../common/guards/permissions.guard.js';
import { AssetCheckoutService } from './asset-checkout.service.js';
import { CheckoutAcceptancesService } from './checkout-acceptances.service.js';
import { CheckoutRequestsService, type RequestableKind } from './checkout-requests.service.js';
import { DirectoryService } from './directory.service.js';
import { HardwareService } from './hardware.service.js';
import { parse } from './inventory-queries.js';

const tag = z.string().trim().min(1).max(255);
const requestableKindMap: Record<RequestableType, RequestableKind> = {
  hardware: 'asset',
  models: 'model',
  licenses: 'license',
  accessories: 'accessory',
  consumables: 'consumable',
  components: 'component',
};
const TypedRequestSchema = z.enum(['models', 'licenses', 'accessories', 'consumables', 'components']);
const kind = (value: string): RequestableKind =>
  requestableKindMap[parse(RequestableTypeSchema, value)];

@ApiTags('Hardware Workflows')
@ApiBearerAuth()
@Controller('hardware')
export class AssetWorkflowsController {
  constructor(
    @Inject(AssetCheckoutService) private readonly service: AssetCheckoutService,
    @Inject(DirectoryService) private readonly directory: DirectoryService,
    @Inject(HardwareService) private readonly hardware: HardwareService,
  ) {}

  @Get('targets/:type')
  options(
    @Param('type') type: string,
    @Query() raw: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    const target = parse(z.enum(['user', 'location', 'asset']), type);
    if (
      !permitsKey(user, 'assets.checkout') &&
      !(target === 'location' && permitsKey(user, 'assets.checkin'))
    ) {
      throw new ForbiddenException('Checkout or check-in permission required');
    }
    const query = parse(
      SelectlistQuerySchema.extend({ model_id: InventoryIdSchema.optional() }),
      raw,
    );
    if (target === 'asset') return this.hardware.options(query, user, query.model_id);
    return this.directory.options(target === 'user' ? 'users' : 'locations', query, user, true);
  }

  @Post(':id/checkout')
  @RequireKeyPermission('assets.checkout')
  checkout(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.service.checkout(parse(InventoryIdSchema, id), body, user);
  }

  @Post('bytag/:tag/checkout')
  @RequireKeyPermission('assets.checkout')
  checkoutByTag(
    @Param('tag') assetTag: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.service.checkout(parse(tag, assetTag), body, user);
  }

  @Post(':id/checkin')
  @RequireKeyPermission('assets.checkin')
  checkin(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.service.checkin(parse(InventoryIdSchema, id), body ?? {}, user);
  }

  @Post('bytag/:tag/checkin')
  @RequireKeyPermission('assets.checkin')
  checkinByTag(
    @Param('tag') assetTag: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.service.checkin(parse(tag, assetTag), body ?? {}, user);
  }

  @Post('checkinbytag')
  @RequireKeyPermission('assets.checkin')
  checkinWithTag(@Body() body: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    const { asset_tag, ...changes } = parse(z.object({ asset_tag: tag }).passthrough(), body);
    return this.service.checkin(asset_tag, changes, user);
  }
}

@ApiTags('Account Self-Service')
@ApiBearerAuth()
@Controller('account')
export class InventoryAccountController {
  constructor(
    @Inject(CheckoutAcceptancesService) private readonly acceptances: CheckoutAcceptancesService,
    @Inject(CheckoutRequestsService) private readonly requests: CheckoutRequestsService,
  ) {}

  @Get('accept')
  @ApiOperation({ summary: 'List pending checkout acceptances for the signed-in user' })
  getAcceptances(
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.acceptances.list(parse(DatatableQuerySchema, query), user, req.url);
  }

  @Get('accept/:id')
  getAcceptance(@Param('id') id: string, @CurrentUser() user: AuthenticatedUserContext) {
    return this.acceptances.get(parse(InventoryIdSchema, id), user);
  }

  @Post('accept/:id')
  respond(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.acceptances.respond(parse(InventoryIdSchema, id), body, user);
  }

  @Get('accept/:id/:artifact')
  download(
    @Param('id') id: string,
    @Param('artifact') artifact: string,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.acceptances.download(
      parse(InventoryIdSchema, id),
      parse(z.enum(['eula', 'signature']), artifact),
      user,
    );
  }

  @Get('eulas')
  eulas(
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.acceptances.list(parse(DatatableQuerySchema, query), user, req.url, true);
  }

  @Get('requestable/:type')
  catalog(
    @Param('type') type: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.requests.catalog(kind(type), parse(DatatableQuerySchema, query), user, req.url);
  }

  @Get('requests')
  getRequests(
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.requests.list(parse(DatatableQuerySchema, query), user, req.url);
  }

  @Post('requests/:id/cancel')
  cancelRequest(@Param('id') id: string, @CurrentUser() user: AuthenticatedUserContext) {
    return this.requests.cancel(parse(InventoryIdSchema, id), user);
  }

  @Post('request/:id')
  @ApiOperation({ summary: 'Request a hardware asset from the self-service catalog' })
  requestAsset(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.requests.create('asset', parse(InventoryIdSchema, id), body, user);
  }

  @Post('request/:id/cancel')
  @ApiOperation({ summary: 'Cancel a pending self-service asset request' })
  cancelAsset(@Param('id') id: string, @CurrentUser() user: AuthenticatedUserContext) {
    return this.requests.cancelByItem('asset', parse(InventoryIdSchema, id), user);
  }

  @Post('request/:type/:id')
  @ApiOperation({ summary: 'Request a model or secondary inventory item from the catalog' })
  requestTypedItem(
    @Param('type') type: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    const resolved = requestableKindMap[parse(TypedRequestSchema, type)];
    return this.requests.create(resolved, parse(InventoryIdSchema, id), body, user);
  }

  @Post('request/:type/:id/cancel')
  @ApiOperation({ summary: 'Cancel a pending self-service request for a model or secondary item' })
  cancelTypedItem(
    @Param('type') type: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    const resolved = requestableKindMap[parse(TypedRequestSchema, type)];
    return this.requests.cancelByItem(resolved, parse(InventoryIdSchema, id), user);
  }
}

@ApiTags('Checkout Requests Queue')
@ApiBearerAuth()
@Controller('requests')
export class InventoryRequestsController {
  constructor(
    @Inject(CheckoutRequestsService) private readonly requests: CheckoutRequestsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List pending checkout requests for operator fulfillment' })
  list(
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.requests.list(parse(DatatableQuerySchema, query), user, req.url, true);
  }

  @Post(':id/fulfill')
  @ApiOperation({ summary: 'Fulfill a pending checkout request' })
  fulfill(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.requests.fulfill(parse(InventoryIdSchema, id), body, user);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel a pending checkout request as operator' })
  cancel(@Param('id') id: string, @CurrentUser() user: AuthenticatedUserContext) {
    return this.requests.cancel(parse(InventoryIdSchema, id), user, true);
  }
}

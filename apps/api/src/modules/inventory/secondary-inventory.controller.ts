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
  Query,
  Req,
} from '@nestjs/common';
import {
  DatatableQuerySchema,
  InventoryIdSchema,
  InventoryIdsSchema,
  SECONDARY_RESOURCES,
  SelectlistQuerySchema,
  type AuthenticatedUserContext,
  type SecondaryResource,
} from '@kestrel-it/shared';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import { DirectoryService } from './directory.service.js';
import { HardwareService } from './hardware.service.js';
import { requireInventoryPermission } from './phase-three-queries.js';
import { parse } from './inventory-queries.js';
import { SecondaryAssignmentsService } from './secondary-assignments.service.js';
import { SecondaryCatalogService } from './secondary-catalog.service.js';

type FastifyRequest = { url: string; routeOptions: { url: string } };

const id = (value: string) => parse(InventoryIdSchema, value);
const resource = (request: FastifyRequest) => {
  const segment = request.routeOptions.url
    ?.split('/')
    .find((part) => SECONDARY_RESOURCES.includes(part as SecondaryResource));
  if (!segment) throw new NotFoundException();
  return segment as SecondaryResource;
};
const querySchema = DatatableQuerySchema.extend({
  deleted: z
    .enum(['0', '1'])
    .transform((value) => value === '1')
    .optional(),
});

@Controller([...SECONDARY_RESOURCES])
export class SecondaryInventoryController {
  constructor(
    @Inject(SecondaryCatalogService) private readonly catalog: SecondaryCatalogService,
    @Inject(SecondaryAssignmentsService) private readonly workflows: SecondaryAssignmentsService,
    @Inject(DirectoryService) private readonly directory: DirectoryService,
    @Inject(HardwareService) private readonly hardware: HardwareService,
  ) {}

  @Get()
  list(
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: FastifyRequest,
  ) {
    return this.catalog.list(resource(req), parse(querySchema, query), user, req.url);
  }

  @Get('selectlist')
  options(
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: FastifyRequest,
  ) {
    return this.catalog.options(resource(req), parse(SelectlistQuerySchema, query), user);
  }

  @Get('targets/:type')
  targets(
    @Param('type') value: string,
    @Query() raw: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: FastifyRequest,
  ) {
    requireInventoryPermission(user, `${resource(req)}.checkout`, true);
    const type = parse(z.enum(['asset', 'user', 'location']), value);
    const query = parse(SelectlistQuerySchema, raw);
    if (type === 'asset') return this.hardware.options(query, user);
    return this.directory.options(type === 'user' ? 'users' : 'locations', query, user, true);
  }

  @Get(':id')
  get(
    @Param('id') value: string,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: FastifyRequest,
  ) {
    return this.catalog.get(resource(req), id(value), user);
  }

  @Post()
  create(
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: FastifyRequest,
  ) {
    return this.catalog.save(resource(req), body, user);
  }

  @Patch(':id')
  update(
    @Param('id') value: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: FastifyRequest,
  ) {
    return this.catalog.save(resource(req), body, user, id(value));
  }

  @Put(':id')
  replace(
    @Param('id') value: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: FastifyRequest,
  ) {
    return this.update(value, body, user, req);
  }

  @Delete(':id')
  remove(
    @Param('id') value: string,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: FastifyRequest,
  ) {
    return this.catalog.archiveAction(resource(req), id(value), 'delete', user);
  }

  @Post(':id/restore')
  restore(
    @Param('id') value: string,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: FastifyRequest,
  ) {
    return this.catalog.archiveAction(resource(req), id(value), 'restore', user);
  }

  @Post(':id/unarchive')
  unarchive(
    @Param('id') value: string,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: FastifyRequest,
  ) {
    return this.catalog.archiveAction(resource(req), id(value), 'unarchive', user);
  }

  @Post(['bulkedit', 'bulkdelete', 'bulkrestore'])
  bulk(
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: FastifyRequest,
  ) {
    const path = req.routeOptions.url;
    const action = path.endsWith('/bulkedit')
      ? 'edit'
      : path.endsWith('/bulkdelete')
        ? 'delete'
        : 'restore';
    return this.catalog.bulk(resource(req), action, body, user);
  }

  @Get(':id/history')
  history(
    @Param('id') value: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: FastifyRequest,
  ) {
    return this.catalog.history(
      resource(req),
      id(value),
      parse(DatatableQuerySchema, query),
      user,
      req.url,
    );
  }

  @Get([':id/seats', ':id/checkedout', ':id/users', ':id/assets'])
  assignments(
    @Param('id') value: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: FastifyRequest,
  ) {
    const kind = resource(req);
    const suffix = {
      licenses: 'seats',
      accessories: 'checkedout',
      consumables: 'users',
      components: 'assets',
    }[kind];
    if (!req.routeOptions.url.endsWith('/' + suffix)) throw new NotFoundException();
    return this.workflows.assignments(
      kind,
      id(value),
      parse(DatatableQuerySchema, query),
      user,
      req.url,
    );
  }

  @Post(':id/checkout')
  checkout(
    @Param('id') value: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: FastifyRequest,
  ) {
    return this.workflows.checkout(resource(req), id(value), body, user);
  }

  @Post(':id/checkin')
  checkin(
    @Param('id') value: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: FastifyRequest,
  ) {
    return this.workflows.checkin(resource(req), id(value), body, user);
  }

  @Post(':id/adjust-quantity')
  adjust(
    @Param('id') value: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: FastifyRequest,
  ) {
    return this.workflows.adjust(resource(req), id(value), body, user);
  }
}

@Controller('licenses/:licenseId/seats')
export class LicenseSeatsController {
  constructor(
    @Inject(SecondaryAssignmentsService) private readonly workflows: SecondaryAssignmentsService,
  ) {}

  @Get(':seatId')
  seat(
    @Param('licenseId') license: string,
    @Param('seatId') seat: string,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.workflows.seat(id(license), id(seat), user);
  }

  @Patch(':seatId')
  change(
    @Param('licenseId') license: string,
    @Param('seatId') seat: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    if (body?.target_id === null)
      return this.workflows.checkin('licenses', id(license), { ...body, seat_id: id(seat) }, user);
    return this.workflows.checkout('licenses', id(license), { ...body, seat_id: id(seat) }, user);
  }

  @Put(':seatId')
  replace(
    @Param('licenseId') license: string,
    @Param('seatId') seat: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.change(license, seat, body, user);
  }
}

@Controller('consumables')
export class ConsumableActionsController {
  constructor(
    @Inject(SecondaryAssignmentsService) private readonly workflows: SecondaryAssignmentsService,
  ) {}

  @Post(':id/consume/:assignment')
  consume(
    @Param('id') item: string,
    @Param('assignment') assignment: string,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.workflows.consume([id(assignment)], user, id(item));
  }

  @Post('bulkconsume')
  bulk(@Body('ids') ids: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    return this.workflows.consume(parse(InventoryIdsSchema, ids), user);
  }
}

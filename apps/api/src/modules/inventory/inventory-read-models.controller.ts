import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { DatatableQuerySchema, type AuthenticatedUserContext } from '@kestrel-it/shared';
import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import { parse } from './inventory-queries.js';
import {
  CalendarQuerySchema,
  InventoryReadModelsService,
  OrderQuerySchema,
} from './inventory-read-models.service.js';

@Controller()
export class InventoryReadModelsController {
  constructor(
    @Inject(InventoryReadModelsService) private readonly views: InventoryReadModelsService,
  ) {}

  @Get('calendar/events')
  calendar(@Query() query: Record<string, unknown>, @CurrentUser() user: AuthenticatedUserContext) {
    return this.views.calendar(
      parse(CalendarQuerySchema, {
        ...query,
        event_type: query.event_type ?? query['event_type[]'],
      }),
      user,
    );
  }

  @Get('order-items')
  orders(
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.views.acquisitionLines(
      parse(DatatableQuerySchema.merge(OrderQuerySchema), query),
      user,
      req.url,
    );
  }

  @Get('low-stock')
  stock(
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.views.lowStock(parse(DatatableQuerySchema, query), user, req.url);
  }
}

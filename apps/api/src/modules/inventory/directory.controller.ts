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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  DatatableQuerySchema,
  InventoryIdSchema,
  SelectlistQuerySchema,
  type AuthenticatedUserContext,
} from '@kestrel-it/shared';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import { DirectoryService } from './directory.service.js';
import { parse } from './inventory-queries.js';

const directoryQuery = DatatableQuerySchema.extend({
  deleted: z
    .enum(['0', '1'])
    .transform((value) => value === '1')
    .optional(),
});

@ApiTags('Directory & Taxonomy')
@ApiBearerAuth()
@Controller()
export class DirectoryController {
  constructor(@Inject(DirectoryService) private readonly directory: DirectoryService) {}

  @Get(':resource')
  list(
    @Param('resource') resource: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() request: { url: string },
  ) {
    return this.directory.list(resource, parse(directoryQuery, query), user, request.url);
  }

  @Get(':resource/selectlist')
  options(
    @Param('resource') resource: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.directory.options(resource, parse(SelectlistQuerySchema, query), user);
  }

  @Get(':resource/:id')
  get(
    @Param('resource') resource: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.directory.get(resource, parse(InventoryIdSchema, id), user);
  }

  @Post(':resource')
  create(
    @Param('resource') resource: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.directory.create(resource, body, user);
  }

  @Patch(':resource/bulk')
  bulk(
    @Param('resource') resource: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.directory.bulk(resource, body, user);
  }

  @Patch(':resource/:id')
  update(
    @Param('resource') resource: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.directory.update(resource, parse(InventoryIdSchema, id), body, user);
  }

  @Put(':resource/:id')
  replace(
    @Param('resource') resource: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.update(resource, id, body, user);
  }

  @Delete(':resource/:id')
  remove(
    @Param('resource') resource: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.directory.remove(resource, parse(InventoryIdSchema, id), user);
  }

  @Post(':resource/:id/restore')
  restore(
    @Param('resource') resource: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.directory.bulk(
      resource,
      { action: 'restore', ids: [parse(InventoryIdSchema, id)] },
      user,
    );
  }
}

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
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import { CustomFieldsService } from './custom-fields.service.js';
import { parse } from './inventory-queries.js';

abstract class CustomFieldCatalogController {
  protected constructor(
    protected readonly service: CustomFieldsService,
    private readonly kind: 'fields' | 'fieldsets',
  ) {}

  @Get()
  list(
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    return this.service.list(this.kind, parse(DatatableQuerySchema, query), user, req.url);
  }

  @Get('selectlist')
  options(@Query() query: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    return this.service.options(this.kind, parse(SelectlistQuerySchema, query), user);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUserContext) {
    return this.service.get(this.kind, parse(InventoryIdSchema, id), user);
  }

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    return this.kind === 'fields'
      ? this.service.saveField(body, user)
      : this.service.saveFieldset(body, user);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    const recordId = parse(InventoryIdSchema, id);
    return this.kind === 'fields'
      ? this.service.saveField(body, user, recordId)
      : this.service.saveFieldset(body, user, recordId);
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
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUserContext) {
    return this.service.remove(this.kind, parse(InventoryIdSchema, id), user);
  }
}

@Controller('fields')
export class CustomFieldsController extends CustomFieldCatalogController {
  constructor(@Inject(CustomFieldsService) service: CustomFieldsService) {
    super(service, 'fields');
  }

  @Post(':id/associate')
  associate(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    const input = parse(
      z.object({ fieldset_id: InventoryIdSchema, required: z.boolean().optional() }).strict(),
      body,
    );
    return this.service.associate(
      input.fieldset_id,
      { field_id: parse(InventoryIdSchema, id), required: input.required },
      user,
    );
  }

  @Post(':id/disassociate')
  disassociate(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    const { fieldset_id } = parse(z.object({ fieldset_id: InventoryIdSchema }).strict(), body);
    return this.service.associate(
      fieldset_id,
      { field_id: parse(InventoryIdSchema, id) },
      user,
      true,
    );
  }

  @Post('fieldsets/:id/order')
  reorder(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.service.reorder(parse(InventoryIdSchema, id), body, user);
  }
}

@Controller('fieldsets')
export class CustomFieldsetsController extends CustomFieldCatalogController {
  constructor(@Inject(CustomFieldsService) service: CustomFieldsService) {
    super(service, 'fieldsets');
  }

  @Post(':id/fields')
  associate(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.service.associate(parse(InventoryIdSchema, id), body, user);
  }

  @Get(':id/fields/:model')
  defaults(
    @Param('id') id: string,
    @Param('model') model: string,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.service.getDefaults(
      parse(InventoryIdSchema, id),
      parse(InventoryIdSchema, model),
      user,
    );
  }

  @Post(':id/fields/:model')
  saveDefaults(
    @Param('id') id: string,
    @Param('model') model: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.service.saveDefaults(
      parse(InventoryIdSchema, id),
      parse(InventoryIdSchema, model),
      body,
      user,
    );
  }
}

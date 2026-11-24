import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Multipart } from '@fastify/multipart';
import {
  AssetAuditSchema,
  InventoryIdsSchema,
  DatatableQuerySchema,
  InventoryIdSchema,
  type AuthenticatedUserContext,
} from '@kestrel-it/shared';
import { z } from 'zod';
import { CurrentUser, RequireKeyPermission } from '../../common/decorators/auth.decorators.js';
import { AssetAuditsService, MAX_AUDIT_PHOTO_BYTES } from './asset-audits.service.js';
import { fieldIssue } from './custom-fields-validation.service.js';
import { parse } from './inventory-queries.js';
import { ApiZodBody } from '../../openapi/request-body.js';

type AuditRequest = {
  url: string;
  isMultipart?: () => boolean;
  parts: (options: {
    limits: { fileSize: number; files: number; fields: number };
  }) => AsyncIterable<Multipart>;
};
const id = (value: string) => parse(InventoryIdSchema, value);

async function auditInput(
  req: AuditRequest,
  body: unknown,
): Promise<{ data: unknown; photo?: Buffer }> {
  if (!req.isMultipart?.()) return { data: body ?? {} };
  const fields: Record<string, unknown> = Object.create(null);
  let photo: Buffer | undefined;
  for await (const part of req.parts({
    limits: { fileSize: MAX_AUDIT_PHOTO_BYTES, files: 1, fields: 25 },
  })) {
    if (part.type === 'file') {
      const bytes = await part.toBuffer();
      if (!['photo', 'image', 'file', 'file[0]'].includes(part.fieldname))
        fieldIssue('photo', 'Unexpected upload field');
      photo = bytes;
    } else {
      fields[part.fieldname] = part.value;
    }
  }
  const json = (value: unknown, field: string) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      fieldIssue(field, 'Enter valid JSON');
    }
  };
  const data = json(fields.payload, 'payload');
  if (data === undefined) {
    for (const key of ['ids', 'custom_fields']) fields[key] = json(fields[key], key);
    if (fields.location_id === '') fields.location_id = null;
  }
  return { data: data ?? fields, photo };
}

@ApiTags('Audits')
@ApiBearerAuth()
@Controller('hardware')
export class AssetAuditsController {
  constructor(@Inject(AssetAuditsService) private readonly audits: AssetAuditsService) {}

  @ApiZodBody(AssetAuditSchema)
  @Post('audit')
  @RequireKeyPermission('assets.audit')
  async legacy(
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: AuditRequest,
  ) {
    const { data, photo } = await auditInput(req, body);
    return this.audits.single(undefined, data, photo, user);
  }

  @Get(':id/audit')
  @RequireKeyPermission('assets.audit')
  context(@Param('id') value: string, @CurrentUser() user: AuthenticatedUserContext) {
    return this.audits.context(id(value), user);
  }

  @ApiZodBody(AssetAuditSchema, false)
  @Post(':id/audit')
  @RequireKeyPermission('assets.audit')
  async single(
    @Param('id') value: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: AuditRequest,
  ) {
    const { data, photo } = await auditInput(req, body);
    return this.audits.single(id(value), data, photo, user);
  }

  @ApiZodBody(AssetAuditSchema.extend({ ids: InventoryIdsSchema }))
  @Post('audit/bulk')
  @RequireKeyPermission('assets.audit')
  async bulk(
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: AuditRequest,
  ) {
    const { data, photo } = await auditInput(req, body);
    return this.audits.bulk(data, photo, user);
  }

  @Get(':id/audits/:auditId/photo')
  photo(
    @Param('id') value: string,
    @Param('auditId') audit: string,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.audits.download(id(value), id(audit), user);
  }

  @Get(':action/:status')
  due(
    @Param('action') action: string,
    @Param('status') status: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: AuditRequest,
  ) {
    return this.audits.list(
      parse(z.enum(['audit', 'audits', 'checkins']), action),
      parse(z.enum(['due', 'overdue', 'due-or-overdue']), status),
      parse(DatatableQuerySchema, query),
      user,
      req.url,
    );
  }
}

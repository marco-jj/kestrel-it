import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  InventoryIdSchema,
  LabelLayoutSchema,
  type AuthenticatedUserContext,
  type LabelLayout,
} from '@kestrel-it/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { ConfigService } from '@nestjs/config';
import bwip from 'bwip-js';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import type { EnvConfig } from '../../config/env.schema.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import { assets, companies, customUserLabels, locations, models } from '../../db/schema/index.js';
import { FmcsScopeService } from './fmcs-scope.service.js';
import { HardwareService } from './hardware.service.js';
import { inventoryWrite, parse, success } from './inventory-queries.js';
import { attachmentResponse } from './operational-files.controller.js';
import { currentSettings, requireInventoryPermission } from './phase-three-queries.js';

const inch = (width: number, height: number, margin_x = 0.1875, margin_y = 0.5, gap_x = 0.125) =>
  LabelLayoutSchema.parse({
    width,
    height,
    page_width: 8.5,
    page_height: 11,
    margin_x,
    margin_y,
    gap_x,
  });
const roll = (width: number, height: number) =>
  LabelLayoutSchema.parse({
    type: 'roll',
    width,
    height,
    page_width: width,
    page_height: height,
  });
export const labelPresets: Record<string, LabelLayout> = {
  Avery5160: inch(2.625, 1),
  Avery5161: inch(4, 1, 0.15625, 0.5, 0.1875),
  Avery5162: inch(4, 1.333, 0.15625, 0.833, 0.1875),
  Avery5163: inch(4, 2, 0.15625, 0.5, 0.1875),
  Avery5164: inch(4, 3.333, 0.15625, 0.5, 0.1875),
  Dymo30252: roll(3.5, 1.125),
  Dymo30334: roll(2.25, 1.25),
  Zebra: roll(2, 1),
};

const codes = {
  C128: 'code128',
  C39: 'code39',
  EAN13: 'ean13',
  UPCA: 'upca',
  ITF: 'interleaved2of5',
  QRCODE: 'qrcode',
  DATAMATRIX: 'datamatrix',
  PDF417: 'pdf417',
} as const;
type LabelRecord = { id: number; asset_tag: string; [key: string]: unknown };

export function barcodeImage(format: keyof typeof codes, text: string, linear: boolean) {
  return bwip.toBuffer({
    bcid: codes[format],
    text,
    scale: 3,
    padding: 10,
    ...(linear ? { height: 10 } : {}),
  });
}

export function labelGeometry(layout: LabelLayout) {
  const scale = layout.units === 'mm' ? 72 / 25.4 : 72;
  const columns =
    layout.type === 'roll'
      ? 1
      : Math.floor(
          (layout.page_width - 2 * layout.margin_x + layout.gap_x + 0.0001) /
            (layout.width + layout.gap_x),
        );
  const rows =
    layout.type === 'roll'
      ? 1
      : Math.floor(
          (layout.page_height - 2 * layout.margin_y + layout.gap_y + 0.0001) /
            (layout.height + layout.gap_y),
        );
  if (
    columns < 1 ||
    rows < 1 ||
    layout.width + 2 * layout.margin_x > layout.page_width + 0.0001 ||
    layout.height + 2 * layout.margin_y > layout.page_height + 0.0001 ||
    Math.min(layout.width, layout.height) * scale < 12 ||
    Math.max(layout.page_width, layout.page_height) * scale > 14400 ||
    layout.skipped >= columns * rows
  )
    throw new UnprocessableEntityException(
      'Label dimensions or initial skipped slots do not fit the page',
    );
  return { scale, columns, slots: columns * rows };
}

export async function renderLabels(layout: LabelLayout, entries: LabelRecord[], appUrl: string) {
  const { scale, columns, slots } = labelGeometry(layout);
  const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.once('end', () => resolve(Buffer.concat(chunks)));
    doc.once('error', reject);
  });
  try {
    for (const [index, row] of entries.entries()) {
      const slot = (index + layout.skipped) % slots;
      if (index === 0 || slot === 0)
        doc.addPage({ size: [layout.page_width * scale, layout.page_height * scale], margin: 0 });
      const x = (layout.margin_x + (slot % columns) * (layout.width + layout.gap_x)) * scale;
      const y =
        (layout.margin_y + Math.floor(slot / columns) * (layout.height + layout.gap_y)) * scale;
      const w = layout.width * scale;
      const h = layout.height * scale;
      const codeWidth = layout.code2d === 'none' ? 0 : Math.min(w * 0.34, h * 0.72);
      const barcodeHeight = layout.barcode === 'none' ? 0 : Math.min(20, h * 0.26);
      if (codeWidth) {
        const identifier = layout.target === 'asset_tag' ? row.asset_tag : String(row.id);
        const target = layout.prefix
          ? layout.prefix + encodeURIComponent(identifier)
          : new URL(
              '/hardware/' +
                (layout.target === 'asset_tag' ? 'bytag/' : '') +
                encodeURIComponent(identifier),
              appUrl,
            ).href;
        doc.image(
          await barcodeImage(layout.code2d as keyof typeof codes, target, false),
          x + w - codeWidth - 3,
          y + 3,
          { fit: [codeWidth, codeWidth] },
        );
      }
      if (barcodeHeight) {
        doc.image(
          await barcodeImage(layout.barcode as keyof typeof codes, row.asset_tag, true),
          x + 3,
          y + h - barcodeHeight - 2,
          { fit: [w - 6, barcodeHeight] },
        );
      }
      const description = [layout.title, ...layout.fields.map((field) => row[field])]
        .filter((value) => value != null && value !== '')
        .join('\n');
      if (description)
        doc.fontSize(layout.font_size).text(description, x + 3, y + 3, {
          width: Math.max(5, w - codeWidth - 8),
          height: Math.max(1, h - barcodeHeight - 6),
          ellipsis: true,
        });
    }
    doc.end();
  } catch {
    doc.end();
    await completed.catch(() => undefined);
    throw new UnprocessableEntityException(
      'A label could not be encoded with the selected format or dimensions',
    );
  }
  return completed;
}

const templateInput = z.object({
  name: z.string().trim().min(1).max(100),
  base_label: z.string().max(100).nullable().optional(),
  layout: LabelLayoutSchema,
  is_default: z.boolean().default(false),
});
const printInput = z.object({
  asset_tags: z.array(z.string().trim().min(1).max(255)).min(1).max(250),
  template: z.string().max(100).optional(),
  skipped: z.number().int().min(0).max(100).optional(),
  format: z.enum(['json', 'pdf']).default('json'),
});

@Controller()
export class LabelsController {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(FmcsScopeService) private readonly fmcs: FmcsScopeService,
    @Inject(HardwareService) private readonly hardware: HardwareService,
    @Inject(ConfigService) private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  private admin(user: AuthenticatedUserContext) {
    if (!user.isSuperUser)
      throw new ForbiddenException('Only superusers can manage label templates');
  }

  @Get('labels')
  async list(@CurrentUser() user: AuthenticatedUserContext) {
    requireInventoryPermission(user, 'assets.view');
    const custom = await this.db
      .select()
      .from(customUserLabels)
      .where(isNull(customUserLabels.deletedAt))
      .orderBy(customUserLabels.name);
    return success([
      ...Object.entries(labelPresets).map(([name, layout]) => ({ name, layout })),
      ...custom.map((row) => ({
        id: row.id,
        name: row.name,
        layout: row.configSnapshot,
        is_default: row.isDefault,
      })),
    ]);
  }

  @Get('labels/:name')
  async show(@Param('name') name: string, @CurrentUser() user: AuthenticatedUserContext) {
    requireInventoryPermission(user, 'assets.view');
    const layout = await this.layout(name);
    return success({ name, layout });
  }

  private async layout(name?: string): Promise<LabelLayout> {
    if (name && Object.hasOwn(labelPresets, name)) return { ...labelPresets[name]! };
    const [custom] = await this.db
      .select()
      .from(customUserLabels)
      .where(
        and(
          isNull(customUserLabels.deletedAt),
          name ? eq(customUserLabels.name, name) : eq(customUserLabels.isDefault, true),
        ),
      )
      .limit(1);
    if (custom) return parse(LabelLayoutSchema, custom.configSnapshot);
    if (name) throw new NotFoundException('Label template not found');
    const settings = await currentSettings(this.db);
    if (!settings) return labelPresets.Avery5160!;
    const preset = settings.label2Template && labelPresets[settings.label2Template];
    return parse(LabelLayoutSchema, {
      ...(preset || {
        width: Number(settings.labelsWidth),
        height: Number(settings.labelsHeight),
        page_width: Number(settings.labelsPagewidth),
        page_height: Number(settings.labelsPageheight),
        margin_x: Number(settings.labelsPmarginLeft),
        margin_y: Number(settings.labelsPmarginTop),
        gap_x: Number(settings.labelsDisplaySgutter),
        gap_y: Number(settings.labelsDisplayBgutter),
      }),
      fields: settings.label2Fields.length
        ? settings.label2Fields
        : [
            settings.labelsDisplayTag && 'asset_tag',
            settings.labelsDisplayName && 'name',
            settings.labelsDisplaySerial && 'serial',
            settings.labelsDisplayModel && 'model',
            settings.labelsDisplayCompanyName && 'company',
          ].filter(Boolean),
      font_size: settings.labelsFontsize,
      skipped: settings.label2EmptyRowCount,
      barcode: settings.label21dType,
      code2d: settings.qrCode ? settings.label22dType : 'none',
      target: settings.label22dTarget === 'asset_tag' ? 'asset_tag' : 'hardware_id',
      prefix: settings.label22dPrefix ?? '',
      title: settings.label2Title ?? '',
    });
  }

  @Post('labels')
  create(@Body() raw: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    return this.save(raw, user);
  }

  @Patch('labels/:id')
  edit(
    @Param('id') id: string,
    @Body() raw: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
  ) {
    return this.save(raw, user, parse(InventoryIdSchema, id));
  }

  private async save(raw: unknown, user: AuthenticatedUserContext, id?: number) {
    this.admin(user);
    const input = parse(templateInput, raw);
    labelGeometry(input.layout);
    return inventoryWrite(this.db, async (tx) => {
      const [duplicate] = await tx
        .select()
        .from(customUserLabels)
        .where(and(eq(customUserLabels.name, input.name), isNull(customUserLabels.deletedAt)));
      if (Object.hasOwn(labelPresets, input.name) || (duplicate && duplicate.id !== id))
        throw new UnprocessableEntityException('Label template name is already used');
      if (input.is_default)
        await tx
          .update(customUserLabels)
          .set({ isDefault: false })
          .where(eq(customUserLabels.isDefault, true));
      const values = {
        name: input.name,
        type: input.layout.type,
        baseLabel: input.base_label,
        configSnapshot: input.layout,
        isDefault: input.is_default,
        updatedAt: new Date(),
      };
      const [row] =
        id === undefined
          ? await tx.insert(customUserLabels).values(values).returning()
          : await tx
              .update(customUserLabels)
              .set(values)
              .where(and(eq(customUserLabels.id, id), isNull(customUserLabels.deletedAt)))
              .returning();
      if (!row) throw new NotFoundException('Label template not found');
      return success({
        id: row.id,
        name: row.name,
        layout: input.layout,
        is_default: row.isDefault,
      });
    });
  }

  @Delete('labels/:id')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUserContext) {
    this.admin(user);
    const [row] = await this.db
      .update(customUserLabels)
      .set({ deletedAt: new Date(), isDefault: false })
      .where(
        and(
          eq(customUserLabels.id, parse(InventoryIdSchema, id)),
          isNull(customUserLabels.deletedAt),
        ),
      )
      .returning();
    if (!row) throw new NotFoundException('Label template not found');
    return success(null);
  }

  @Post('labels/preview')
  @HttpCode(200)
  async preview(
    @Body() raw: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Res() reply: FastifyReply,
  ) {
    this.admin(user);
    const layout = parse(LabelLayoutSchema, raw);
    const tag =
      { EAN13: '590123412345', UPCA: '12345678901', ITF: '12345678' }[layout.barcode as 'EAN13'] ??
      'SAMPLE-001';
    return attachmentResponse(reply, 'label-preview.pdf', 'application/pdf').send(
      await renderLabels(
        layout,
        [{ id: 1, asset_tag: tag, name: 'Sample asset', serial: 'SN-001', model: 'Sample model' }],
        this.config.get('APP_URL', { infer: true }),
      ),
    );
  }

  @Post('hardware/labels')
  @HttpCode(200)
  async print(
    @Body() raw: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Res() reply: FastifyReply,
  ) {
    requireInventoryPermission(user, 'assets.view');
    const input = parse(printInput, raw);
    const layout = await this.layout(input.template);
    if (input.skipped !== undefined) layout.skipped = input.skipped;
    const scope = await this.fmcs.resolve(user);
    const rows = await this.db
      .select({
        asset: assets,
        model: models.name,
        model_number: models.modelNumber,
        company: companies.name,
        location: locations.name,
      })
      .from(assets)
      .leftJoin(models, eq(models.id, assets.modelId))
      .leftJoin(companies, eq(companies.id, assets.companyId))
      .leftJoin(
        locations,
        and(
          eq(locations.id, assets.locationId),
          this.fmcs.predicate(scope, 'locations', locations.id, locations.companyId),
        ),
      )
      .where(
        and(
          isNull(assets.deletedAt),
          inArray(assets.assetTag, input.asset_tags),
          this.fmcs.predicate(scope, 'assets', assets.id, assets.companyId),
        ),
      );
    if (rows.length !== new Set(input.asset_tags).size)
      throw new NotFoundException('One or more assets could not be found');
    const byTag = new Map(rows.map((row) => [row.asset.assetTag, row]));
    const entries = await Promise.all(
      [...new Set(input.asset_tags)].map(async (tag) => {
        const row = byTag.get(tag)!;
        const asset = this.hardware.serialize(
          row.asset,
          null,
          await this.hardware.assetFields(this.db, row.asset.modelId),
          user,
        );
        const custom = Object.fromEntries(
          Object.entries(asset.custom_fields).map(([key, field]) =>
            field.value === 'ENCRYPTED' ? [key, null] : [field.field, field.value],
          ),
        );
        return {
          ...custom,
          id: asset.id,
          asset_tag: tag,
          name: asset.name,
          serial: asset.serial,
          purchase_date: asset.purchase_date?.formatted,
          model: row.model,
          model_number: row.model_number,
          company: row.company,
          location: row.location,
        };
      }),
    );
    const pdf = await renderLabels(layout, entries, this.config.get('APP_URL', { infer: true }));
    return input.format === 'pdf'
      ? attachmentResponse(reply, 'asset-labels.pdf', 'application/pdf').send(pdf)
      : reply.send(success({ pdf: pdf.toString('base64') }));
  }
}

import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Patch,
  Query,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AccountProfileUpdateSchema,
  DatatableQuerySchema,
  GeneralSettingsUpdateSchema,
  type AuthenticatedUserContext,
} from '@kestrel-it/shared';
import { and, count, desc, eq, isNull, ne, or } from 'drizzle-orm';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import { actionLogs, loginAttempts, settings, users } from '../../db/schema/index.js';
import { userEmailMatches } from '../../db/user-email.js';
import { contains, datatable, inventoryWrite, pageOffset, parse, success } from './inventory-queries.js';
import { currentSettings } from './phase-three-queries.js';

@ApiTags('Admin Settings & Account Profile')
@ApiBearerAuth()
@Controller()
export class SettingsAdminController {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(CryptoService) private readonly crypto: CryptoService,
  ) {}

  private requireSuperuser(user: AuthenticatedUserContext) {
    if (!user.isSuperUser) {
      throw new ForbiddenException('Only superusers can access global settings');
    }
  }

  @Get('settings')
  @ApiOperation({ summary: 'Return sanitized global instance, branding, security, and OIDC settings' })
  async getSettings(@CurrentUser() user: AuthenticatedUserContext) {
    this.requireSuperuser(user);
    const row = await currentSettings(this.db);
    if (!row) throw new NotFoundException('Settings not found');
    return success({
      site_name: row.siteName,
      per_page: row.perPage,
      locale: row.locale,
      default_currency: row.defaultCurrency,
      date_display_format: row.dateDisplayFormat,
      time_display_format: row.timeDisplayFormat,
      auto_increment_assets: row.autoIncrementAssets,
      auto_increment_prefix: row.autoIncrementPrefix,
      next_auto_tag_base: row.nextAutoTagBase,
      zerofill_count: row.zerofillCount,
      unique_serial: row.uniqueSerial,
      full_multiple_companies_support: row.fullMultipleCompaniesSupport,
      scope_locations_fmcs: row.scopeLocationsFmcs,
      null_company_is_floater: row.nullCompanyIsFloater,
      default_eula_text: row.defaultEulaText,
      require_accept_signature: row.requireAcceptSignature,
      require_checkinout_notes: row.requireCheckinoutNotes,
      require_adjust_quantity_notes: row.requireAdjustQuantityNotes,
      depreciation_method: row.depreciationMethod,
      two_factor_enabled: row.twoFactorEnabled,
      pwd_secure_min: row.pwdSecureMin,
      profile_edit: row.profileEdit,
      show_assigned_assets: row.showAssignedAssets,
      show_archived_in_list: row.showArchivedInList,
      dash_chart_type: row.dashChartType,
      header_color: row.headerColor,
      nav_link_color: row.navLinkColor,
      link_light_color: row.linkLightColor,
      link_dark_color: row.linkDarkColor,
      custom_css: row.customCss,
      footer_text: row.footerText,
      privacy_policy_link: row.privacyPolicyLink,
      dashboard_message: row.dashboardMessage,
      login_note: row.loginNote,
      oidc_enabled: row.oidcEnabled,
      oidc_issuer_url: row.oidcIssuerUrl,
      oidc_client_id: row.oidcClientId,
      oidc_client_secret_configured: Boolean(row.oidcClientSecretEncrypted),
      oidc_scopes: row.oidcScopes,
      oidc_auto_provision_users: row.oidcAutoProvisionUsers,
      oidc_link_existing_users: row.oidcLinkExistingUsers,
      oidc_sync_on_login: row.oidcSyncOnLogin,
      oidc_sync_groups: row.oidcSyncGroups,
      oidc_username_claim: row.oidcUsernameClaim,
      oidc_groups_claim: row.oidcGroupsClaim,
    });
  }

  @Patch('settings')
  @ApiOperation({ summary: 'Update global instance, branding, security, and OIDC settings' })
  async updateSettings(@Body() raw: unknown, @CurrentUser() user: AuthenticatedUserContext) {
    this.requireSuperuser(user);
    const dto = parse(GeneralSettingsUpdateSchema, raw ?? {});
    await inventoryWrite(this.db, async (tx) => {
      const config = await currentSettings(tx);
      if (!config) throw new NotFoundException('Settings not found');
      const updates: Partial<typeof settings.$inferInsert> = {
        updatedAt: new Date(),
        ...(dto.site_name !== undefined ? { siteName: dto.site_name } : {}),
        ...(dto.per_page !== undefined ? { perPage: dto.per_page } : {}),
        ...(dto.locale !== undefined ? { locale: dto.locale } : {}),
        ...(dto.default_currency !== undefined ? { defaultCurrency: dto.default_currency } : {}),
        ...(dto.date_display_format !== undefined ? { dateDisplayFormat: dto.date_display_format } : {}),
        ...(dto.time_display_format !== undefined ? { timeDisplayFormat: dto.time_display_format } : {}),
        ...(dto.auto_increment_assets !== undefined
          ? { autoIncrementAssets: dto.auto_increment_assets }
          : {}),
        ...(dto.auto_increment_prefix !== undefined
          ? { autoIncrementPrefix: dto.auto_increment_prefix }
          : {}),
        ...(dto.zerofill_count !== undefined ? { zerofillCount: dto.zerofill_count } : {}),
        ...(dto.unique_serial !== undefined ? { uniqueSerial: dto.unique_serial } : {}),
        ...(dto.full_multiple_companies_support !== undefined
          ? { fullMultipleCompaniesSupport: dto.full_multiple_companies_support }
          : {}),
        ...(dto.scope_locations_fmcs !== undefined
          ? { scopeLocationsFmcs: dto.scope_locations_fmcs }
          : {}),
        ...(dto.null_company_is_floater !== undefined
          ? { nullCompanyIsFloater: dto.null_company_is_floater }
          : {}),
        ...(dto.default_eula_text !== undefined ? { defaultEulaText: dto.default_eula_text } : {}),
        ...(dto.require_accept_signature !== undefined
          ? { requireAcceptSignature: dto.require_accept_signature }
          : {}),
        ...(dto.require_checkinout_notes !== undefined
          ? { requireCheckinoutNotes: dto.require_checkinout_notes }
          : {}),
        ...(dto.require_adjust_quantity_notes !== undefined
          ? { requireAdjustQuantityNotes: dto.require_adjust_quantity_notes }
          : {}),
        ...(dto.depreciation_method !== undefined
          ? { depreciationMethod: dto.depreciation_method }
          : {}),
        ...(dto.two_factor_enabled !== undefined
          ? { twoFactorEnabled: dto.two_factor_enabled }
          : {}),
        ...(dto.pwd_secure_min !== undefined ? { pwdSecureMin: dto.pwd_secure_min } : {}),
        ...(dto.profile_edit !== undefined ? { profileEdit: dto.profile_edit } : {}),
        ...(dto.show_assigned_assets !== undefined
          ? { showAssignedAssets: dto.show_assigned_assets }
          : {}),
        ...(dto.show_archived_in_list !== undefined
          ? { showArchivedInList: dto.show_archived_in_list }
          : {}),
        ...(dto.dash_chart_type !== undefined ? { dashChartType: dto.dash_chart_type } : {}),
        ...(dto.header_color !== undefined ? { headerColor: dto.header_color } : {}),
        ...(dto.nav_link_color !== undefined ? { navLinkColor: dto.nav_link_color } : {}),
        ...(dto.link_light_color !== undefined ? { linkLightColor: dto.link_light_color } : {}),
        ...(dto.link_dark_color !== undefined ? { linkDarkColor: dto.link_dark_color } : {}),
        ...(dto.custom_css !== undefined ? { customCss: dto.custom_css } : {}),
        ...(dto.footer_text !== undefined ? { footerText: dto.footer_text } : {}),
        ...(dto.privacy_policy_link !== undefined
          ? { privacyPolicyLink: dto.privacy_policy_link }
          : {}),
        ...(dto.dashboard_message !== undefined
          ? { dashboardMessage: dto.dashboard_message }
          : {}),
        ...(dto.login_note !== undefined ? { loginNote: dto.login_note } : {}),
        ...(dto.oidc_enabled !== undefined ? { oidcEnabled: dto.oidc_enabled } : {}),
        ...(dto.oidc_issuer_url !== undefined ? { oidcIssuerUrl: dto.oidc_issuer_url } : {}),
        ...(dto.oidc_client_id !== undefined ? { oidcClientId: dto.oidc_client_id } : {}),
        ...(dto.oidc_client_secret !== undefined
          ? {
              oidcClientSecretEncrypted: dto.oidc_client_secret
                ? this.crypto.encrypt(dto.oidc_client_secret)
                : null,
            }
          : {}),
        ...(dto.oidc_scopes !== undefined && dto.oidc_scopes !== null
          ? { oidcScopes: dto.oidc_scopes }
          : {}),
        ...(dto.oidc_auto_provision_users !== undefined
          ? { oidcAutoProvisionUsers: dto.oidc_auto_provision_users }
          : {}),
        ...(dto.oidc_link_existing_users !== undefined
          ? { oidcLinkExistingUsers: dto.oidc_link_existing_users }
          : {}),
        ...(dto.oidc_sync_on_login !== undefined
          ? { oidcSyncOnLogin: dto.oidc_sync_on_login }
          : {}),
        ...(dto.oidc_sync_groups !== undefined ? { oidcSyncGroups: dto.oidc_sync_groups } : {}),
        ...(dto.oidc_username_claim !== undefined
          ? { oidcUsernameClaim: dto.oidc_username_claim }
          : {}),
        ...(dto.oidc_groups_claim !== undefined ? { oidcGroupsClaim: dto.oidc_groups_claim } : {}),
      };
      await tx.update(settings).set(updates).where(eq(settings.id, config.id));
      await tx.insert(actionLogs).values({
        createdBy: user.id,
        actionType: 'update',
        itemType: 'setting',
        itemId: config.id,
        actionDate: new Date(),
        actionSource: 'api',
        note: 'Global settings updated',
      });
    });
    return this.getSettings(user);
  }

  @Get('settings/login-attempts')
  @ApiOperation({ summary: 'List paginated authentication attempt audit records (superuser only)' })
  async loginAttempts(
    @Query() raw: unknown,
    @CurrentUser() user: AuthenticatedUserContext,
    @Req() req: { url: string },
  ) {
    this.requireSuperuser(user);
    const query = parse(DatatableQuerySchema, raw);
    const filter = query.search
      ? or(
          contains(loginAttempts.username, query.search),
          contains(loginAttempts.remoteIp, query.search),
          contains(loginAttempts.loginVia, query.search),
        )
      : undefined;
    const [[totalRow], rows] = await Promise.all([
      this.db.select({ value: count() }).from(loginAttempts).where(filter),
      this.db
        .select()
        .from(loginAttempts)
        .where(filter)
        .orderBy(desc(loginAttempts.createdAt), desc(loginAttempts.id))
        .limit(query.limit)
        .offset(pageOffset(query)),
    ]);
    return datatable(
      totalRow!.value,
      rows.map((row) => ({
        id: row.id,
        username: row.username,
        remote_ip: row.remoteIp,
        user_agent: row.userAgent,
        successful: row.successful,
        login_via: row.loginVia,
        created_at: row.createdAt.toISOString(),
      })),
      query,
      req.url,
    );
  }

  @Get('account/profile')
  @ApiOperation({ summary: 'Return current user profile details and password/2FA policy state' })
  async profile(@CurrentUser() actor: AuthenticatedUserContext) {
    const [row] = await this.db
      .select()
      .from(users)
      .where(andUser(actor.id))
      .limit(1);
    if (!row) throw new NotFoundException('User not found');
    const config = await currentSettings(this.db);
    return success({
      id: row.id,
      username: row.username,
      first_name: row.firstName,
      last_name: row.lastName,
      display_name: row.displayName,
      email: row.email,
      phone: row.phone,
      locale: row.locale,
      two_factor_enrolled: row.twoFactorEnrolled,
      two_factor_policy: config?.twoFactorEnabled ?? 0,
      profile_edit: config?.profileEdit ?? true,
      pwd_secure_min: config?.pwdSecureMin ?? 10,
      has_local_password: Boolean(row.password),
      auth_method: actor.authMethod,
    });
  }

  @Patch('account/profile')
  @ApiOperation({ summary: 'Update signed-in user profile details or local password' })
  async updateProfile(@Body() raw: unknown, @CurrentUser() actor: AuthenticatedUserContext) {
    const dto = parse(AccountProfileUpdateSchema, raw ?? {});
    await inventoryWrite(this.db, async (tx) => {
      const config = await currentSettings(tx);
      if (config && !config.profileEdit && !actor.isSuperUser) {
        throw new ForbiddenException('Self-service profile editing is disabled');
      }
      const [row] = await tx.select().from(users).where(andUser(actor.id)).limit(1).for('update');
      if (!row) throw new NotFoundException('User not found');
      if (dto.email && dto.email !== row.email) {
        const [duplicate] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(
            ne(users.id, actor.id),
            isNull(users.deletedAt),
            userEmailMatches(users.email, dto.email),
          ))
          .limit(1);
        if (duplicate) {
          throw new ConflictException({
            status: 'error',
            messages: { email: ['Email is already in use'] },
            payload: null,
          });
        }
      }
      let nextPasswordHash: string | undefined;
      if (dto.new_password) {
        if (!row.password) {
          throw new ForbiddenException('This account has no local password to change');
        }
        const minLen = config?.pwdSecureMin ?? 10;
        if (dto.new_password.length < minLen) {
          throw new UnprocessableEntityException({
            status: 'error',
            messages: { new_password: [`Password must be at least ${minLen} characters`] },
            payload: null,
          });
        }
        const ok = await this.crypto.verifyPassword(dto.current_password ?? '', row.password);
        if (!ok) {
          throw new UnprocessableEntityException({
            status: 'error',
            messages: { current_password: ['Current password is incorrect'] },
            payload: null,
          });
        }
        nextPasswordHash = this.crypto.hashPassword(dto.new_password);
      }
      const firstName = dto.first_name !== undefined ? dto.first_name : row.firstName;
      const lastName = dto.last_name !== undefined ? dto.last_name : row.lastName;
      const computedDisplay =
        dto.display_name !== undefined
          ? dto.display_name
          : dto.first_name !== undefined || dto.last_name !== undefined
            ? [firstName, lastName].filter(Boolean).join(' ').trim() || row.username
            : row.displayName;
      await tx
        .update(users)
        .set({
          firstName,
          lastName,
          displayName: computedDisplay,
          ...(dto.email !== undefined ? { email: dto.email } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.locale !== undefined ? { locale: dto.locale } : {}),
          ...(nextPasswordHash ? { password: nextPasswordHash } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, actor.id));
      await tx.insert(actionLogs).values({
        createdBy: actor.id,
        actionType: 'update',
        itemType: 'user',
        itemId: actor.id,
        actionDate: new Date(),
        actionSource: 'api',
        note: 'Self-service profile updated',
      });
    });
    return this.profile(actor);
  }
}

function andUser(id: number) {
  return and(eq(users.id, id), isNull(users.deletedAt));
}

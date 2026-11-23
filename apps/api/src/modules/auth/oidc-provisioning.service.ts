import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { EnvConfig } from '../../config/env.schema.js';
import { DRIZZLE_DB, type DrizzleDb } from '../../db/database.module.js';
import {
  actionLogs,
  companyUser,
  groups,
  settings,
  users,
  usersGroups,
} from '../../db/schema/index.js';

function extractClaimValue(claims: Record<string, unknown>, path: string): unknown {
  if (!path) {
    return undefined;
  }
  if (Object.hasOwn(claims, path)) {
    return claims[path];
  }
  const parts = path.split('.');
  let current: unknown = claims;
  for (const part of parts) {
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return [value.trim()];
  }
  return [];
}

@Injectable()
export class OidcUserProvisioningService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(ConfigService) private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  /**
   * Resolves an OIDC identity to an existing user, links a pre-existing user, or creates
   * a new user Just-In-Time (JIT) and synchronizes profile, groups, and company memberships.
   */
  async resolveOrProvisionUser(
    claims: Record<string, unknown>,
  ): Promise<typeof users.$inferSelect> {
    const issuer = asNonEmptyString(claims['iss']);
    const subject = asNonEmptyString(claims['sub']);

    if (!issuer || !subject) {
      throw new UnauthorizedException('OIDC token missing required iss or sub claim');
    }

    const policy = await this.loadProvisioningPolicy();

    // Step 1: Direct lookup by (oidc_issuer, oidc_subject)
    let resolvedUser = await this.findUserByOidcTuple(issuer, subject);
    let isNewlyCreated = false;

    if (resolvedUser && !resolvedUser.activated) {
      throw new UnauthorizedException('User account is deactivated');
    }

    // Step 2: Account linking & pinning fallback for pre-existing / migrated users
    if (!resolvedUser && policy.linkExistingUsers) {
      resolvedUser = await this.tryLinkExistingUser({
        claims,
        usernameClaim: policy.usernameClaim,
        issuer,
        subject,
      });
    }

    // Step 3: Just-In-Time (JIT) user auto-provisioning
    if (!resolvedUser) {
      if (!policy.autoProvisionUsers) {
        throw new UnauthorizedException(
          'OIDC user not found and JIT auto-provisioning is disabled',
        );
      }

      const provisioned = await this.jitProvisionUser({
        claims,
        usernameClaim: policy.usernameClaim,
        issuer,
        subject,
        defaultLocale: policy.defaultLocale,
      });
      resolvedUser = provisioned.user;
      isNewlyCreated = provisioned.isNewlyCreated;
    }

    // Step 4: Sync profile attributes, groups, and company membership on login
    if (isNewlyCreated || policy.syncOnLogin) {
      resolvedUser = await this.applyLoginSync({
        user: resolvedUser,
        isNewlyCreated,
        claims,
        policy,
      });
    }

    return resolvedUser;
  }

  private async loadProvisioningPolicy() {
    const [settingsRow] = await this.db.select().from(settings).limit(1);

    return {
      autoProvisionUsers:
        settingsRow?.oidcAutoProvisionUsers ??
        this.config.get('OIDC_AUTO_PROVISION_USERS', { infer: true }),
      linkExistingUsers:
        settingsRow?.oidcLinkExistingUsers ??
        this.config.get('OIDC_LINK_EXISTING_USERS', { infer: true }),
      syncOnLogin:
        settingsRow?.oidcSyncOnLogin ?? this.config.get('OIDC_SYNC_ON_LOGIN', { infer: true }),
      syncGroups:
        settingsRow?.oidcSyncGroups ?? this.config.get('OIDC_SYNC_GROUPS', { infer: true }),
      usernameClaim:
        settingsRow?.oidcUsernameClaim ||
        this.config.get('OIDC_USERNAME_CLAIM', { infer: true }) ||
        'preferred_username',
      groupsClaim:
        settingsRow?.oidcGroupsClaim ||
        this.config.get('OIDC_GROUPS_CLAIM', { infer: true }) ||
        'groups',
      defaultGroupId: settingsRow?.oidcDefaultGroupId ?? null,
      defaultCompanyId: settingsRow?.oidcDefaultCompanyId ?? null,
      groupMapping: settingsRow?.oidcGroupMapping ?? {},
      defaultLocale: settingsRow?.locale || 'en-US',
    };
  }

  private async findUserByOidcTuple(
    issuer: string,
    subject: string,
  ): Promise<typeof users.$inferSelect | null> {
    const [byTuple] = await this.db
      .select()
      .from(users)
      .where(
        and(eq(users.oidcIssuer, issuer), eq(users.oidcSubject, subject), isNull(users.deletedAt)),
      )
      .limit(1);
    return byTuple ?? null;
  }

  private async tryLinkExistingUser(params: {
    claims: Record<string, unknown>;
    usernameClaim: string;
    issuer: string;
    subject: string;
  }): Promise<typeof users.$inferSelect | null> {
    const { claims, usernameClaim, issuer, subject } = params;
    const claimUsername = asNonEmptyString(extractClaimValue(claims, usernameClaim));
    const claimEmail = claims['email_verified'] === true ? asNonEmptyString(claims['email']) : null;

    const candidate = await this.findLinkCandidate(claimUsername, claimEmail);
    if (!candidate) {
      return null;
    }

    if (!candidate.activated) {
      throw new UnauthorizedException('User account is deactivated');
    }
    if (candidate.oidcIssuer && candidate.oidcIssuer !== issuer) {
      throw new UnauthorizedException('User is already pinned to a different OIDC issuer');
    }
    if (candidate.oidcSubject && candidate.oidcSubject !== subject) {
      throw new UnauthorizedException('User is already pinned to a different OIDC subject');
    }

    const [pinned] = await this.db
      .update(users)
      .set({
        oidcIssuer: issuer,
        oidcSubject: subject,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(users.id, candidate.id),
          eq(users.activated, true),
          isNull(users.deletedAt),
          eq(users.username, candidate.username),
          candidate.email === null ? isNull(users.email) : eq(users.email, candidate.email),
          candidate.oidcIssuer == null
            ? isNull(users.oidcIssuer)
            : eq(users.oidcIssuer, candidate.oidcIssuer),
          candidate.oidcSubject == null
            ? isNull(users.oidcSubject)
            : eq(users.oidcSubject, candidate.oidcSubject),
        ),
      )
      .returning();

    if (!pinned) {
      throw new UnauthorizedException('User identity changed during OIDC account linking');
    }
    return pinned;
  }

  private async findLinkCandidate(
    claimUsername: string | null,
    claimEmail: string | null,
  ): Promise<typeof users.$inferSelect | undefined> {
    if (claimUsername) {
      const [byUsername] = await this.db
        .select()
        .from(users)
        .where(and(eq(users.username, claimUsername), isNull(users.deletedAt)))
        .limit(1);
      if (byUsername) {
        return byUsername;
      }
    }

    if (claimEmail) {
      const [byEmail] = await this.db
        .select()
        .from(users)
        .where(and(eq(users.email, claimEmail), isNull(users.deletedAt)))
        .limit(1);
      return byEmail;
    }

    return undefined;
  }

  private async jitProvisionUser(params: {
    claims: Record<string, unknown>;
    usernameClaim: string;
    issuer: string;
    subject: string;
    defaultLocale: string;
  }): Promise<{ user: typeof users.$inferSelect; isNewlyCreated: boolean }> {
    const { claims, usernameClaim, issuer, subject, defaultLocale } = params;
    const mapped = this.mapProfileFromClaims(claims, usernameClaim, subject, defaultLocale);

    const createdUser = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({
          username: mapped.username,
          email: mapped.email,
          firstName: mapped.firstName,
          lastName: mapped.lastName,
          displayName: mapped.displayName,
          employeeNum: mapped.employeeNum,
          jobtitle: mapped.jobtitle,
          phone: mapped.phone,
          locale: mapped.locale,
          password: null,
          activated: true,
          activatedAt: new Date(),
          remote: true,
          autoassignLicenses: true,
          oidcIssuer: issuer,
          oidcSubject: subject,
        })
        .onConflictDoNothing()
        .returning();

      if (!created) return undefined;

      await tx.insert(actionLogs).values({
        createdBy: created.id,
        actionType: 'create',
        itemType: 'user',
        itemId: created.id,
        actionDate: new Date(),
        actionSource: 'oidc_jit',
        note: `Auto-provisioned via OIDC (${issuer})`,
      });

      return created;
    });

    const concurrentUser = createdUser ? null : await this.findUserByOidcTuple(issuer, subject);
    const resolvedUser = createdUser ?? concurrentUser;
    if (!resolvedUser?.activated) {
      throw new UnauthorizedException('OIDC account could not be provisioned');
    }
    return {
      user: resolvedUser,
      isNewlyCreated: Boolean(createdUser),
    };
  }

  private async applyLoginSync(params: {
    user: typeof users.$inferSelect;
    isNewlyCreated: boolean;
    claims: Record<string, unknown>;
    policy: Awaited<ReturnType<OidcUserProvisioningService['loadProvisioningPolicy']>>;
  }): Promise<typeof users.$inferSelect> {
    let resolvedUser = params.user;

    if (!params.isNewlyCreated) {
      const profileUpdates = this.buildProfileUpdates(params.claims, resolvedUser);
      if (Object.keys(profileUpdates).length > 0) {
        const [updated] = await this.db
          .update(users)
          .set({ ...profileUpdates, updatedAt: new Date() })
          .where(eq(users.id, resolvedUser.id))
          .returning();
        if (updated) {
          resolvedUser = updated;
        }
      }
    }

    await this.syncGroupsAndCompany({
      userId: resolvedUser.id,
      isNewlyCreated: params.isNewlyCreated,
      syncGroups: params.policy.syncGroups,
      claims: params.claims,
      groupsClaim: params.policy.groupsClaim,
      defaultGroupId: params.policy.defaultGroupId,
      defaultCompanyId: params.policy.defaultCompanyId,
      groupMapping: params.policy.groupMapping,
    });

    return resolvedUser;
  }

  private mapProfileFromClaims(
    claims: Record<string, unknown>,
    usernameClaim: string,
    subject: string,
    defaultLocale: string,
  ) {
    const email = asNonEmptyString(claims['email']);
    const username = asNonEmptyString(extractClaimValue(claims, usernameClaim)) ?? email ?? subject;
    const fullName = asNonEmptyString(claims['name']);
    const givenName = asNonEmptyString(claims['given_name']);
    const familyName = asNonEmptyString(claims['family_name']);

    let firstName = givenName;
    let lastName = familyName;

    if (!firstName && fullName) {
      const parts = fullName.split(/\s+/);
      firstName = parts[0] ?? username;
      lastName = lastName ?? (parts.slice(1).join(' ') || null);
    }

    firstName = firstName ?? username;
    const displayName = fullName ?? `${firstName} ${lastName ?? ''}`.trim();

    return {
      username,
      email,
      firstName,
      lastName: lastName ?? '',
      displayName,
      employeeNum: asNonEmptyString(claims['employee_number']),
      jobtitle: asNonEmptyString(claims['title'] ?? claims['job_title']),
      phone: asNonEmptyString(claims['phone_number']),
      locale: asNonEmptyString(claims['locale']) ?? defaultLocale,
    };
  }

  private buildProfileUpdates(
    claims: Record<string, unknown>,
    existing: typeof users.$inferSelect,
  ): Partial<typeof users.$inferInsert> {
    const candidateFields = {
      email: asNonEmptyString(claims['email']),
      firstName: asNonEmptyString(claims['given_name']),
      lastName: asNonEmptyString(claims['family_name']),
      displayName: asNonEmptyString(claims['name']),
      employeeNum: asNonEmptyString(claims['employee_number']),
      jobtitle: asNonEmptyString(claims['title'] ?? claims['job_title']),
      phone: asNonEmptyString(claims['phone_number']),
      locale: asNonEmptyString(claims['locale']),
    } as const;

    const updates: Partial<typeof users.$inferInsert> = {};
    for (const key of Object.keys(candidateFields) as Array<keyof typeof candidateFields>) {
      const nextValue = candidateFields[key];
      if (nextValue && nextValue !== existing[key]) {
        updates[key] = nextValue;
      }
    }

    return updates;
  }

  private async syncGroupsAndCompany(params: {
    userId: number;
    isNewlyCreated: boolean;
    syncGroups: boolean;
    claims: Record<string, unknown>;
    groupsClaim: string;
    defaultGroupId: number | null;
    defaultCompanyId: number | null;
    groupMapping: Record<string, number>;
  }): Promise<void> {
    if (params.syncGroups) {
      const desiredGroupIds = await this.resolveDesiredGroupIds(params);

      await this.db.transaction(async (tx) => {
        await tx.delete(usersGroups).where(eq(usersGroups.userId, params.userId));
        if (desiredGroupIds.size > 0) {
          await tx
            .insert(usersGroups)
            .values([...desiredGroupIds].map((groupId) => ({ userId: params.userId, groupId })))
            .onConflictDoNothing();
        }
      });
    } else if (params.isNewlyCreated && params.defaultGroupId) {
      await this.db
        .insert(usersGroups)
        .values({ userId: params.userId, groupId: params.defaultGroupId })
        .onConflictDoNothing();
    }

    if (params.defaultCompanyId) {
      await this.db
        .insert(companyUser)
        .values({ userId: params.userId, companyId: params.defaultCompanyId })
        .onConflictDoNothing();
    }
  }

  private async resolveDesiredGroupIds(params: {
    claims: Record<string, unknown>;
    groupsClaim: string;
    defaultGroupId: number | null;
    groupMapping: Record<string, number>;
  }): Promise<Set<number>> {
    const claimGroupNames = asStringArray(extractClaimValue(params.claims, params.groupsClaim));
    const desiredGroupIds = new Set<number>();

    if (params.defaultGroupId) {
      desiredGroupIds.add(params.defaultGroupId);
    }

    const unmappedNames: string[] = [];
    for (const name of claimGroupNames) {
      const mappedId = params.groupMapping[name];
      if (typeof mappedId === 'number' && Number.isInteger(mappedId)) {
        desiredGroupIds.add(mappedId);
      } else {
        unmappedNames.push(name);
      }
    }

    if (unmappedNames.length > 0) {
      const matchedGroups = await this.db
        .select({ id: groups.id })
        .from(groups)
        .where(inArray(groups.name, unmappedNames));
      for (const group of matchedGroups) {
        desiredGroupIds.add(group.id);
      }
    }

    return desiredGroupIds;
  }
}

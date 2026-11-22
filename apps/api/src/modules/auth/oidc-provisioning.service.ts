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
  if (Object.prototype.hasOwnProperty.call(claims, path)) {
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

    const [settingsRow] = await this.db.select().from(settings).limit(1);

    const autoProvisionUsers =
      settingsRow?.oidcAutoProvisionUsers ??
      this.config.get('OIDC_AUTO_PROVISION_USERS', { infer: true });
    const linkExistingUsers =
      settingsRow?.oidcLinkExistingUsers ??
      this.config.get('OIDC_LINK_EXISTING_USERS', { infer: true });
    const syncOnLogin =
      settingsRow?.oidcSyncOnLogin ?? this.config.get('OIDC_SYNC_ON_LOGIN', { infer: true });
    const syncGroups =
      settingsRow?.oidcSyncGroups ?? this.config.get('OIDC_SYNC_GROUPS', { infer: true });
    const usernameClaim =
      settingsRow?.oidcUsernameClaim ||
      this.config.get('OIDC_USERNAME_CLAIM', { infer: true }) ||
      'preferred_username';
    const groupsClaim =
      settingsRow?.oidcGroupsClaim ||
      this.config.get('OIDC_GROUPS_CLAIM', { infer: true }) ||
      'groups';
    const defaultGroupId = settingsRow?.oidcDefaultGroupId ?? null;
    const defaultCompanyId = settingsRow?.oidcDefaultCompanyId ?? null;
    const groupMapping = settingsRow?.oidcGroupMapping ?? {};
    const defaultLocale = settingsRow?.locale || 'en-US';

    // Step 1: Direct lookup by (oidc_issuer, oidc_subject)
    const identity = and(
      eq(users.oidcIssuer, issuer),
      eq(users.oidcSubject, subject),
      isNull(users.deletedAt),
    );
    const [byTuple] = await this.db
      .select()
      .from(users)
      .where(identity)
      .limit(1);

    let resolvedUser = byTuple ?? null;
    let isNewlyCreated = false;

    if (resolvedUser && !resolvedUser.activated) {
      throw new UnauthorizedException('User account is deactivated');
    }

    // Step 2: Account linking & pinning fallback for pre-existing / migrated users
    if (!resolvedUser && linkExistingUsers) {
      const claimUsername = asNonEmptyString(extractClaimValue(claims, usernameClaim));
      const claimEmail =
        claims['email_verified'] === true ? asNonEmptyString(claims['email']) : null;

      let candidate: typeof users.$inferSelect | undefined;
      if (claimUsername) {
        [candidate] = await this.db
          .select()
          .from(users)
          .where(and(eq(users.username, claimUsername), isNull(users.deletedAt)))
          .limit(1);
      }

      if (!candidate && claimEmail) {
        [candidate] = await this.db
          .select()
          .from(users)
          .where(and(eq(users.email, claimEmail), isNull(users.deletedAt)))
          .limit(1);
      }

      if (candidate) {
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
          .where(and(
            eq(users.id, candidate.id),
            eq(users.activated, true),
            isNull(users.deletedAt),
            candidate.oidcIssuer == null
              ? isNull(users.oidcIssuer)
              : eq(users.oidcIssuer, candidate.oidcIssuer),
            candidate.oidcSubject == null
              ? isNull(users.oidcSubject)
              : eq(users.oidcSubject, candidate.oidcSubject),
          ))
          .returning();

        if (!pinned) {
          throw new UnauthorizedException('User identity changed during OIDC account linking');
        }
        resolvedUser = pinned;
      }
    }

    // Step 3: Just-In-Time (JIT) user auto-provisioning
    if (!resolvedUser) {
      if (!autoProvisionUsers) {
        throw new UnauthorizedException(
          'OIDC user not found and JIT auto-provisioning is disabled',
        );
      }

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

      const [concurrentUser] = createdUser ? [] : await this.db.select().from(users).where(identity).limit(1);
      resolvedUser = createdUser ?? concurrentUser ?? null;
      if (!resolvedUser?.activated) {
        throw new UnauthorizedException('OIDC account could not be provisioned');
      }
      isNewlyCreated = Boolean(createdUser);
    }

    // Step 4: Sync profile attributes, groups, and company membership on login
    if (isNewlyCreated || syncOnLogin) {
      if (!isNewlyCreated) {
        const profileUpdates = this.buildProfileUpdates(claims, resolvedUser);
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
        isNewlyCreated,
        syncGroups,
        claims,
        groupsClaim,
        defaultGroupId,
        defaultCompanyId,
        groupMapping,
      });
    }

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
    const updates: Partial<typeof users.$inferInsert> = {};

    const email = asNonEmptyString(claims['email']);
    if (email && email !== existing.email) {
      updates.email = email;
    }

    const givenName = asNonEmptyString(claims['given_name']);
    if (givenName && givenName !== existing.firstName) {
      updates.firstName = givenName;
    }

    const familyName = asNonEmptyString(claims['family_name']);
    if (familyName && familyName !== existing.lastName) {
      updates.lastName = familyName;
    }

    const fullName = asNonEmptyString(claims['name']);
    if (fullName && fullName !== existing.displayName) {
      updates.displayName = fullName;
    }

    const employeeNum = asNonEmptyString(claims['employee_number']);
    if (employeeNum && employeeNum !== existing.employeeNum) {
      updates.employeeNum = employeeNum;
    }

    const jobtitle = asNonEmptyString(claims['title'] ?? claims['job_title']);
    if (jobtitle && jobtitle !== existing.jobtitle) {
      updates.jobtitle = jobtitle;
    }

    const phone = asNonEmptyString(claims['phone_number']);
    if (phone && phone !== existing.phone) {
      updates.phone = phone;
    }

    const locale = asNonEmptyString(claims['locale']);
    if (locale && locale !== existing.locale) {
      updates.locale = locale;
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
}

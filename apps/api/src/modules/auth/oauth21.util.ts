import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';

const PKCE_VERIFIER_REGEX = /^[A-Za-z0-9\-._~]{43,128}$/;

export interface OAuth21AuthorizationValidationParams {
  responseType: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  codeVerifier?: string;
  redirectUri?: string;
  expectedRedirectUri?: string;
}

/**
 * Enforces OAuth 2.1 security invariants:
 * - Authorization Code flow only (disallows deprecated Implicit 'token' and ROPC 'password')
 * - Mandatory PKCE with S256 (disallows 'plain' or missing challenge)
 * - Exact redirect URI matching with HTTPS requirement (localhost permitted for local dev)
 */
export function validateOAuth21AuthorizationRequest(
  params: OAuth21AuthorizationValidationParams,
): void {
  if (params.responseType !== 'code') {
    throw new BadRequestException(
      `OAuth 2.1 requires response_type="code"; "${params.responseType}" flow is disallowed`,
    );
  }

  if (params.codeChallengeMethod !== 'S256') {
    throw new BadRequestException(
      'OAuth 2.1 requires PKCE code_challenge_method="S256"; plain or missing PKCE is disallowed',
    );
  }

  if (!params.codeChallenge) {
    throw new BadRequestException('OAuth 2.1 requires PKCE code_challenge');
  }

  if (params.codeVerifier !== undefined) {
    if (!PKCE_VERIFIER_REGEX.test(params.codeVerifier)) {
      throw new BadRequestException('Invalid PKCE code_verifier format (RFC 7636)');
    }
    const derivedChallenge = computeS256CodeChallenge(params.codeVerifier);
    if (derivedChallenge !== params.codeChallenge) {
      throw new UnauthorizedException('PKCE code_verifier does not match S256 code_challenge');
    }
  }

  if (params.redirectUri !== undefined) {
    validateRedirectUri(params.redirectUri, params.expectedRedirectUri);
  }
}

function validateRedirectUri(redirectUri: string, expectedRedirectUri?: string): void {
  if (expectedRedirectUri && redirectUri !== expectedRedirectUri) {
    throw new BadRequestException('OAuth 2.1 redirect_uri must match the registered URI exactly');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(redirectUri);
  } catch {
    throw new BadRequestException('Invalid OAuth redirect_uri URL');
  }

  const isLocalhost =
    parsedUrl.hostname === 'localhost' ||
    parsedUrl.hostname === '127.0.0.1' ||
    parsedUrl.hostname === '[::1]';

  if (parsedUrl.protocol !== 'https:' && !isLocalhost) {
    throw new BadRequestException('OAuth 2.1 redirect_uri must use HTTPS outside localhost');
  }
}

export function computeS256CodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function extractStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item === 'object' && 'name' in item) {
          return asNonEmptyString((item as Record<string, unknown>)['name']) ?? '';
        }
        return '';
      })
      .filter((s) => s.length > 0);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return undefined;
}

/**
 * Normalizes pure OAuth 2.0 / 2.1 UserInfo profiles (GitHub, GitLab, Google, Nextcloud, custom IdPs)
 * into the canonical OIDC claims schema consumed by OidcUserProvisioningService.
 */
export function normalizeOAuthUserInfoToClaims(
  rawProfile: Record<string, unknown>,
  options: { issuerUrl: string },
): Record<string, unknown> {
  // Nextcloud OCS wrapper support ({ ocs: { data: { id, email, displayname, groups } } })
  const ocs = rawProfile['ocs'];
  const unwrapped =
    ocs && typeof ocs === 'object' && 'data' in ocs && typeof (ocs as Record<string, unknown>)['data'] === 'object'
      ? ((ocs as Record<string, unknown>)['data'] as Record<string, unknown>)
      : rawProfile;

  const subject = asNonEmptyString(
    unwrapped['sub'] ?? unwrapped['id'] ?? unwrapped['user_id'] ?? unwrapped['uid'],
  );
  if (!subject) {
    throw new UnauthorizedException('OAuth userinfo response missing subject/id identifier');
  }

  const email = asNonEmptyString(unwrapped['email']);
  const preferredUsername =
    asNonEmptyString(
      unwrapped['preferred_username'] ??
        unwrapped['username'] ??
        unwrapped['login'] ??
        unwrapped['nickname'],
    ) ?? email;

  const fullName = asNonEmptyString(
    unwrapped['name'] ?? unwrapped['displayname'] ?? unwrapped['display_name'],
  );
  const givenName = asNonEmptyString(unwrapped['given_name'] ?? unwrapped['first_name']);
  const familyName = asNonEmptyString(unwrapped['family_name'] ?? unwrapped['last_name']);
  const groups = extractStringList(unwrapped['groups'] ?? unwrapped['roles'] ?? unwrapped['teams']);

  const emailVerifiedRaw = unwrapped['email_verified'] ?? unwrapped['verified_email'];
  const emailVerified =
    typeof emailVerifiedRaw === 'boolean' ? emailVerifiedRaw : Boolean(email);

  const normalized: Record<string, unknown> = {
    iss: options.issuerUrl,
    sub: subject,
    email_verified: emailVerified,
  };

  if (preferredUsername) normalized['preferred_username'] = preferredUsername;
  if (email) normalized['email'] = email;
  if (fullName) normalized['name'] = fullName;
  if (givenName) normalized['given_name'] = givenName;
  if (familyName) normalized['family_name'] = familyName;
  if (groups) normalized['groups'] = groups;

  const employeeNum = asNonEmptyString(
    unwrapped['employee_number'] ?? unwrapped['employee_id'] ?? unwrapped['employeeNumber'],
  );
  if (employeeNum) normalized['employee_number'] = employeeNum;

  const title = asNonEmptyString(unwrapped['title'] ?? unwrapped['job_title'] ?? unwrapped['jobtitle']);
  if (title) normalized['title'] = title;

  const phone = asNonEmptyString(unwrapped['phone_number'] ?? unwrapped['phone']);
  if (phone) normalized['phone_number'] = phone;

  const locale = asNonEmptyString(unwrapped['locale']);
  if (locale) normalized['locale'] = locale;

  return normalized;
}

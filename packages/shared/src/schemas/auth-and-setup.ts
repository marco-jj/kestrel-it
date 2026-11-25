import { z } from 'zod';
import type { PermissionKey } from '../rbac/permissions.js';

export const PreflightChecksSchema = z.object({
  database: z.boolean(),
  storageWritable: z.boolean(),
  oidcConfigured: z.boolean(),
  smtpConfigured: z.boolean(),
});
export type PreflightChecks = z.infer<typeof PreflightChecksSchema>;

export const PreflightStatusResponseSchema = z.object({
  setupCompleted: z.boolean(),
  checks: PreflightChecksSchema,
});
export type PreflightStatusResponse = z.infer<typeof PreflightStatusResponseSchema>;

export const LOCAL_PASSWORD_MIN_LENGTH = 10;
export const LOCAL_PASSWORD_MAX_LENGTH = 255;
export const LocalPasswordSchema = z
  .string({ error: ({ input }) => input == null ? 'Password is required.' : 'Enter a valid password.' })
  .min(LOCAL_PASSWORD_MIN_LENGTH, `Use at least ${LOCAL_PASSWORD_MIN_LENGTH} characters.`)
  .max(LOCAL_PASSWORD_MAX_LENGTH, `Use at most ${LOCAL_PASSWORD_MAX_LENGTH} characters.`);

export const CompleteSetupRequestSchema = z.object({
  siteName: z.string().trim().min(1).max(255),
  locale: z.string().trim().min(2).max(20).default('en-US'),
  defaultCurrency: z.string().trim().min(1).max(10).default('USD'),
  fullMultipleCompaniesSupport: z.boolean().default(false),
  autoIncrementAssets: z.boolean().default(false),
  autoIncrementPrefix: z.string().trim().max(100).nullable().optional(),
  zerofillCount: z.coerce.number().int().min(0).max(20).default(5),
  emailDomain: z.string().trim().max(255).nullable().optional(),
  emailFormat: z.string().trim().max(50).nullable().optional(),
  firstName: z.string().trim().min(1).max(255),
  lastName: z.string().trim().max(255).default(''),
  username: z.string().trim().min(1).max(255),
  email: z.string().trim().email().max(255),
  password: LocalPasswordSchema,
});
export type CompleteSetupRequest = z.infer<typeof CompleteSetupRequestSchema>;

export interface AuthenticatedUserContext {
  id: number;
  username: string;
  email: string | null;
  displayName: string;
  isSuperUser: boolean;
  isAdmin: boolean;
  userCompanyIds: number[];
  groupIds: number[];
  effectivePermissions: Record<PermissionKey, boolean>;
  keyPermissions?: Record<PermissionKey, boolean>;
  twoFactorEnrolled: boolean;
  twoFactorVerified: boolean;
  authMethod: 'jwt' | 'pat';
}

export const AuthenticatedUserContextSchema = z.object({
  id: z.number().int().positive(),
  username: z.string(),
  email: z.string().nullable(),
  displayName: z.string(),
  isSuperUser: z.boolean(),
  isAdmin: z.boolean(),
  userCompanyIds: z.array(z.number().int()),
  groupIds: z.array(z.number().int()),
  effectivePermissions: z.record(z.string(), z.boolean()),
  keyPermissions: z.record(z.string(), z.boolean()).optional(),
  twoFactorEnrolled: z.boolean(),
  twoFactorVerified: z.boolean(),
  authMethod: z.enum(['jwt', 'pat']),
});

export const LoginRequestSchema = z.object({
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(255),
  remember: z.boolean().optional().default(false),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginAuthenticatedResponseSchema = z.object({
  status: z.literal('authenticated'),
  accessToken: z.string(),
  refreshToken: z.string(),
  user: AuthenticatedUserContextSchema,
});

export const LoginTwoFactorRequiredResponseSchema = z.object({
  status: z.literal('2fa_required'),
  requiresTwoFactor: z.literal(true),
  requiresEnrollment: z.boolean(),
  challengeToken: z.string(),
});

export const LoginResponseSchema = z.discriminatedUnion('status', [
  LoginAuthenticatedResponseSchema,
  LoginTwoFactorRequiredResponseSchema,
]);
export type LoginResponse =
  | {
      status: 'authenticated';
      accessToken: string;
      refreshToken: string;
      user: AuthenticatedUserContext;
    }
  | {
      status: '2fa_required';
      requiresTwoFactor: true;
      requiresEnrollment: boolean;
      challengeToken: string;
    };

export const RefreshTokenRequestSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});
export type RefreshTokenRequest = z.infer<typeof RefreshTokenRequestSchema>;

export const TwoFactorEnrollResponseSchema = z.object({
  secret: z.string(),
  otpauthUri: z.string(),
});
export type TwoFactorEnrollResponse = z.infer<typeof TwoFactorEnrollResponseSchema>;

export const TwoFactorVerifyRequestSchema = z.object({
  challengeToken: z.string().min(1).optional(),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Verification code must be 6 digits'),
});
export type TwoFactorVerifyRequest = z.infer<typeof TwoFactorVerifyRequestSchema>;

export const CreatePatRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
  expiresAt: z.string().datetime().nullable().optional(),
});
export type CreatePatRequest = z.infer<typeof CreatePatRequestSchema>;

export const PatSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});
export type PatSummary = z.infer<typeof PatSummarySchema>;

export const CreatePatResponseSchema = PatSummarySchema.extend({
  token: z.string(),
});
export type CreatePatResponse = z.infer<typeof CreatePatResponseSchema>;

export const OAUTH_PROTOCOLS = ['oidc', 'oauth2', 'oauth2.1'] as const;
export type OAuthProtocol = (typeof OAUTH_PROTOCOLS)[number];

export const BETTER_AUTH_MODES = ['disabled', 'embedded', 'federated'] as const;
export type BetterAuthMode = (typeof BETTER_AUTH_MODES)[number];

export const AuthProvidersStatusResponseSchema = z.object({
  local: z.boolean(),
  loginNote: z.string().nullable().optional(),
  twoFactorPolicy: z.number().int(),
  sso: z.object({
    enabled: z.boolean(),
    protocol: z.enum(OAUTH_PROTOCOLS),
    loginPath: z.string(),
  }),
  betterAuth: z.object({
    enabled: z.boolean(),
    mode: z.enum(BETTER_AUTH_MODES),
    passkeyEnabled: z.boolean(),
    providers: z.array(z.string()),
  }),
});
export type AuthProvidersStatusResponse = z.infer<typeof AuthProvidersStatusResponseSchema>;

export const BetterAuthUserPayloadSchema = z.object({
  id: z.string().trim().min(1).max(255),
  email: z.string().trim().email().max(255),
  emailVerified: z.boolean().default(false),
  name: z.string().trim().max(255).optional(),
  username: z.string().trim().max(255).optional(),
  firstName: z.string().trim().max(255).optional(),
  lastName: z.string().trim().max(255).optional(),
  groups: z.array(z.string()).optional(),
  company: z.string().trim().max(255).optional(),
  twoFactorVerified: z.boolean().optional(),
  amr: z.array(z.string()).optional(),
});
export type BetterAuthUserPayload = z.infer<typeof BetterAuthUserPayloadSchema>;

export const BetterAuthSessionExchangeRequestSchema = z.object({
  providerId: z.string().trim().min(1).max(100).default('better-auth'),
  accountId: z.string().trim().min(1).max(255).optional(),
  sessionToken: z.string().trim().min(1).optional(),
  signature: z.string().trim().min(1).optional(),
  issuedAt: z.number().int().positive().optional(),
  nonce: z.string().uuid().optional(),
  user: BetterAuthUserPayloadSchema.optional(),
});
export type BetterAuthSessionExchangeRequest = z.infer<
  typeof BetterAuthSessionExchangeRequestSchema
>;

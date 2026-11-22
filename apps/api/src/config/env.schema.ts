import { STORAGE_DRIVERS } from '@kestrel-it/shared';
import { z } from 'zod';

const optionalBooleanFromEnv = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', ''])])
  .optional()
  .transform((value) =>
    value === undefined || value === '' ? undefined : value === true || value === 'true' || value === '1',
  );

const booleanFromEnv = (defaultValue: boolean) =>
  optionalBooleanFromEnv.transform((value) => value ?? defaultValue);

const DEVELOPMENT_JWT_SECRET = 'dev-only-jwt-secret-change-me-in-production';

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_NAME: z.string().min(1).default('Kestrel-IT'),
  APP_URL: z.string().url().default('http://localhost:4200'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_PREFIX: z.string().min(1).default('api/v1'),

  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgresql://kestrel:kestrel_dev_password@localhost:5432/kestrel_it'),
  DB_AUTO_MIGRATE: booleanFromEnv(true),

  JWT_SECRET: z.string().min(16).default(DEVELOPMENT_JWT_SECRET),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  APP_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'APP_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)')
    .default('0'.repeat(64)),

  // OIDC, OAuth 2.0/2.1 & JIT Auto-Provisioning
  OIDC_ENABLED: optionalBooleanFromEnv,
  OIDC_ISSUER_URL: z.string().optional().default(''),
  OIDC_CLIENT_ID: z.string().optional().default(''),
  OIDC_CLIENT_SECRET: z.string().optional().default(''),
  OIDC_REDIRECT_URI: z.string().optional().default(''),
  OIDC_SCOPES: z.string().default(''),
  OIDC_AUTO_PROVISION_USERS: booleanFromEnv(true),
  OIDC_LINK_EXISTING_USERS: booleanFromEnv(true),
  OIDC_SYNC_ON_LOGIN: booleanFromEnv(true),
  OIDC_SYNC_GROUPS: booleanFromEnv(true),
  OIDC_USERNAME_CLAIM: z.string().default('preferred_username'),
  OIDC_GROUPS_CLAIM: z.string().default('groups'),
  OAUTH_PROTOCOL: z.enum(['oidc', 'oauth2', 'oauth2.1']).default('oidc'),
  OAUTH_AUTHORIZATION_URL: z.string().optional().default(''),
  OAUTH_TOKEN_URL: z.string().optional().default(''),
  OAUTH_USERINFO_URL: z.string().optional().default(''),

  // Better Auth Integration (disabled | embedded | federated)
  BETTER_AUTH_ENABLED: booleanFromEnv(false),
  BETTER_AUTH_MODE: z.enum(['disabled', 'embedded', 'federated']).default('disabled'),
  BETTER_AUTH_SECRET: z.string().optional().default(''),
  BETTER_AUTH_URL: z.string().optional().default(''),
  BETTER_AUTH_PASSKEY_ENABLED: booleanFromEnv(false),
  BETTER_AUTH_PROVIDERS: z.string().default('oidc,oauth2.1'),

  // Pluggable Storage
  STORAGE_DRIVER: z.enum(STORAGE_DRIVERS).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default('./storage'),
  S3_ENDPOINT: z.string().optional().default(''),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional().default(''),
  S3_ACCESS_KEY_ID: z.string().optional().default(''),
  S3_SECRET_ACCESS_KEY: z.string().optional().default(''),
  S3_FORCE_PATH_STYLE: booleanFromEnv(true),
  NEXTCLOUD_URL: z.string().optional().default(''),
  NEXTCLOUD_USERNAME: z.string().optional().default(''),
  NEXTCLOUD_APP_PASSWORD: z.string().optional().default(''),
  NEXTCLOUD_BASE_PATH: z.string().default('/kestrel-it'),

  // SMTP
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_SECURE: booleanFromEnv(false),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  SMTP_FROM_NAME: z.string().default('Kestrel-IT'),
  SMTP_FROM_ADDRESS: z.string().default('noreply@kestrel.example.com'),

  // Optional First-Run Headless Bootstrap
  BOOTSTRAP_SITE_NAME: z.string().optional().default(''),
  BOOTSTRAP_ADMIN_USERNAME: z.string().optional().default(''),
  BOOTSTRAP_ADMIN_EMAIL: z.string().optional().default(''),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional().default(''),
  BOOTSTRAP_ADMIN_FIRST_NAME: z.string().optional().default('Admin'),
  BOOTSTRAP_ADMIN_LAST_NAME: z.string().optional().default('User'),
}).superRefine((env, ctx) => {
  if (env.BETTER_AUTH_ENABLED && env.BETTER_AUTH_SECRET.trim().length < 32) {
    ctx.addIssue({
      code: 'custom',
      path: ['BETTER_AUTH_SECRET'],
      message: 'Better Auth requires a dedicated signing key of at least 32 characters',
    });
  }
  if (env.NODE_ENV !== 'production') return;

  if (env.JWT_SECRET.trim().length < 32 || /^(dev-only|change-me)/i.test(env.JWT_SECRET.trim())) {
    ctx.addIssue({
      code: 'custom',
      path: ['JWT_SECRET'],
      message: 'Production requires a deployment-specific signing key of at least 32 characters',
    });
  }
  if (/^0{64}$/.test(env.APP_ENCRYPTION_KEY)) {
    ctx.addIssue({
      code: 'custom',
      path: ['APP_ENCRYPTION_KEY'],
      message: 'Production requires a deployment-specific encryption key',
    });
  }
});

export type EnvConfig = z.infer<typeof EnvSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const parsed = EnvSchema.safeParse(config);
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${formatted}`);
  }
  return parsed.data;
}

CREATE TABLE "auth_consumed_tokens" (
	"digest" varchar(128) PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DROP INDEX "idx_users_oidc";--> statement-breakpoint
CREATE INDEX "idx_auth_consumed_tokens_expires" ON "auth_consumed_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_active_oidc" ON "users" USING btree ("oidc_issuer","oidc_subject") WHERE "users"."deleted_at" IS NULL AND "users"."oidc_issuer" IS NOT NULL AND "users"."oidc_subject" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "auth_consumed_tokens" ("digest", "expires_at")
SELECT "token_hash", max("expires_at")
FROM "personal_access_tokens"
WHERE "name" = '__refresh_jti__'
  AND "token_hash" LIKE 'refresh_jti:%'
  AND "revoked_at" IS NOT NULL
  AND "expires_at" > now()
GROUP BY "token_hash"
ON CONFLICT ("digest") DO NOTHING;

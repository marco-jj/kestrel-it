ALTER TABLE "report_templates" ADD COLUMN "is_shared" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "run" jsonb;
--> statement-breakpoint
CREATE TABLE "import_row_errors" (
  "import_id" integer NOT NULL REFERENCES "imports"("id") ON DELETE CASCADE,
  "row_number" integer NOT NULL,
  "message" text NOT NULL,
  PRIMARY KEY ("import_id", "row_number")
);
--> statement-breakpoint
ALTER TABLE "inventory_mail_outbox" ADD COLUMN "channel" varchar(32) DEFAULT 'email' NOT NULL;
--> statement-breakpoint
ALTER TABLE "inventory_mail_outbox" ADD COLUMN "company_id" integer REFERENCES "companies"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "inventory_mail_outbox" ADD COLUMN "event" varchar(64);
--> statement-breakpoint
CREATE TABLE "scheduled_job_runs" (
  "job" varchar(64) NOT NULL,
  "period" varchar(32) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("job", "period")
);

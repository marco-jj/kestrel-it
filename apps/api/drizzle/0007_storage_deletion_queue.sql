CREATE TABLE "storage_deletion_queue" (
  "category" varchar(32) NOT NULL,
  "object_key" text NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "available_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("category", "object_key")
);
--> statement-breakpoint
CREATE INDEX "idx_storage_deletion_queue_available" ON "storage_deletion_queue" ("available_at");

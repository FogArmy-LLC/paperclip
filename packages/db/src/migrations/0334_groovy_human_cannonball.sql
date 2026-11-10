-- The registered Paperclip migration executor runs this migration's top-level
-- statements without a file-wide transaction so the index can build without
-- blocking wake writes. Every statement is safe to retry if interrupted.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "execution_sla_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "execution_sla_first_identified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "execution_sla_warning_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "execution_sla_breach_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "execution_sla_warning_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "execution_sla_breach_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "agent_wakeup_requests_execution_sla_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'execution-sla:%';--> statement-breakpoint
UPDATE "issues" SET "execution_sla_first_identified_at" = "blocked_transition_at" WHERE "execution_sla_first_identified_at" IS NULL AND "status" = 'blocked' AND "blocked_transition_at" IS NOT NULL;--> statement-breakpoint

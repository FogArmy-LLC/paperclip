-- Rebuild the index concurrently to align the generated schema snapshot while
-- keeping wake writes available. This migration uses top-level statements.
DROP INDEX CONCURRENTLY IF EXISTS "agent_wakeup_requests_execution_sla_idempotency_uq";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "agent_wakeup_requests_execution_sla_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'execution-sla:%';

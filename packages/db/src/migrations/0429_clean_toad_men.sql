CREATE TABLE "tenant_autonomy_bootstraps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"tenant_slug" text NOT NULL,
	"contract" jsonb NOT NULL,
	"delegation_graph" jsonb NOT NULL,
	"repositories" jsonb NOT NULL,
	"binding" jsonb NOT NULL,
	"source_commit" text NOT NULL,
	"review_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_autonomy_bootstraps" ADD CONSTRAINT "tenant_autonomy_bootstraps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_autonomy_bootstraps_company_tenant_uq" ON "tenant_autonomy_bootstraps" USING btree ("company_id","tenant_slug");--> statement-breakpoint
CREATE INDEX "tenant_autonomy_bootstraps_company_idx" ON "tenant_autonomy_bootstraps" USING btree ("company_id");
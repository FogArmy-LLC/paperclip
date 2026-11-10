import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Company-scoped, non-secret projection of a tenant autonomy bootstrap. */
export const tenantAutonomyBootstraps = pgTable(
  "tenant_autonomy_bootstraps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    tenantSlug: text("tenant_slug").notNull(),
    contract: jsonb("contract").$type<Record<string, unknown>>().notNull(),
    delegationGraph: jsonb("delegation_graph").$type<Record<string, unknown>[]>().notNull(),
    repositories: jsonb("repositories").$type<Record<string, unknown>[]>().notNull(),
    binding: jsonb("binding").$type<Record<string, unknown>>().notNull(),
    sourceCommit: text("source_commit").notNull(),
    reviewAt: timestamp("review_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTenantUq: uniqueIndex("tenant_autonomy_bootstraps_company_tenant_uq").on(table.companyId, table.tenantSlug),
    companyIdx: index("tenant_autonomy_bootstraps_company_idx").on(table.companyId),
  }),
);

import { createHash } from "node:crypto";
import {
  deriveDelegationGraph,
  parseTenantAutonomyContract,
  type DelegationNode,
  type TenantAutonomyContract,
} from "@paperclipai/shared";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tenantAutonomyBootstraps } from "@paperclipai/db";

export type TenantAutonomyArtifact = {
  sourceRepository: string;
  sourceCommit: string;
  sourcePath: string;
  sha256: string;
  content: string;
  authority: "read-only";
};

export type TenantAutonomyBindingReceipt = {
  sourceRepository: string;
  sourceCommit: string;
  sourcePath: string;
  sha256: string;
  authority: "read-only";
  scope: string[];
  reviewAt: string;
  revokeAt: string | null;
};

export type TenantAutonomyBootstrapPlan = {
  contract: TenantAutonomyContract;
  graph: DelegationNode[];
  repositories: TenantAutonomyContract["repositories"]["items"];
  binding: TenantAutonomyBindingReceipt;
};

export type PersistedTenantAutonomyBootstrap = typeof tenantAutonomyBootstraps.$inferSelect;

function assertHexSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("tenant autonomy artifact sha256 must be lowercase hex");
}

/**
 * Consume a cross-project contract only after verifying its exact source and
 * read-only binding. This is intentionally side-effect free; persistence and
 * agent/resource mutation remain with their existing company-scoped services.
 */
export function buildTenantAutonomyBootstrapPlan(input: {
  artifact: TenantAutonomyArtifact;
  expectedSource: { repository: string; commit: string; path: string; sha256: string };
  now?: Date;
  reviewDays?: number;
}): TenantAutonomyBootstrapPlan {
  const { artifact, expectedSource } = input;
  if (artifact.authority !== "read-only") throw new Error("tenant autonomy artifact must be read-only");
  if (artifact.sourceRepository !== expectedSource.repository || artifact.sourceCommit !== expectedSource.commit || artifact.sourcePath !== expectedSource.path) {
    throw new Error("tenant autonomy artifact source identity mismatch");
  }
  assertHexSha256(artifact.sha256);
  if (artifact.sha256 !== expectedSource.sha256) throw new Error("tenant autonomy artifact digest mismatch");
  const actualSha256 = createHash("sha256").update(artifact.content, "utf8").digest("hex");
  if (actualSha256 !== artifact.sha256) throw new Error("tenant autonomy artifact content digest mismatch");

  const contract = parseTenantAutonomyContract(JSON.parse(artifact.content) as unknown);
  const now = input.now ?? new Date();
  const reviewDays = input.reviewDays ?? 30;
  if (!Number.isInteger(reviewDays) || reviewDays <= 0) throw new Error("reviewDays must be a positive integer");
  const reviewAt = new Date(now.getTime() + reviewDays * 86_400_000).toISOString();
  return {
    contract,
    graph: deriveDelegationGraph(contract),
    repositories: contract.repositories.items.filter((item) => item.repo.startsWith(`${contract.repositories.owner_scope}/`)),
    binding: {
      sourceRepository: artifact.sourceRepository,
      sourceCommit: artifact.sourceCommit,
      sourcePath: artifact.sourcePath,
      sha256: artifact.sha256,
      authority: artifact.authority,
      scope: [artifact.sourceRepository, artifact.sourcePath],
      reviewAt,
      revokeAt: null,
    },
  };
}

/** Persist only validated, non-secret contract metadata within one company. */
export function tenantAutonomyService(db: Db) {
  return {
    saveBootstrap: async (companyId: string, plan: TenantAutonomyBootstrapPlan) => {
      const now = new Date();
      return db
        .insert(tenantAutonomyBootstraps)
        .values({
          companyId,
          tenantSlug: plan.contract.tenant.slug,
          contract: plan.contract,
          delegationGraph: plan.graph,
          repositories: plan.repositories,
          binding: plan.binding,
          sourceCommit: plan.binding.sourceCommit,
          reviewAt: new Date(plan.binding.reviewAt),
          revokedAt: plan.binding.revokeAt ? new Date(plan.binding.revokeAt) : null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [tenantAutonomyBootstraps.companyId, tenantAutonomyBootstraps.tenantSlug],
          set: {
            contract: plan.contract,
            delegationGraph: plan.graph,
            repositories: plan.repositories,
            binding: plan.binding,
            sourceCommit: plan.binding.sourceCommit,
            reviewAt: new Date(plan.binding.reviewAt),
            revokedAt: plan.binding.revokeAt ? new Date(plan.binding.revokeAt) : null,
            updatedAt: now,
          },
        })
        .returning()
        .then((rows) => rows[0]);
    },

    getBootstrap: (companyId: string, tenantSlug: string) =>
      db
        .select()
        .from(tenantAutonomyBootstraps)
        .where(and(eq(tenantAutonomyBootstraps.companyId, companyId), eq(tenantAutonomyBootstraps.tenantSlug, tenantSlug)))
        .orderBy(desc(tenantAutonomyBootstraps.updatedAt))
        .then((rows) => rows[0] ?? null),

    listBootstraps: (companyId: string) =>
      db
        .select()
        .from(tenantAutonomyBootstraps)
        .where(eq(tenantAutonomyBootstraps.companyId, companyId))
        .orderBy(desc(tenantAutonomyBootstraps.updatedAt)),
  };
}

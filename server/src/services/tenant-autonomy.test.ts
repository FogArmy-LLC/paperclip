import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { validateRepositoryInTenantScope } from "@paperclipai/shared";
import { buildTenantAutonomyBootstrapPlan, tenantAutonomyService } from "./tenant-autonomy.js";

const content = JSON.stringify({
  schema: 1, tenant: { slug: "fogarmy", display_name: "FogArmy", kind: "operator" }, mode: "managed-autonomy",
  objective_contract: { roadmap_owner: "fas-ceo", roadmap_source: "roadmap", outcomes: ["operate"], acceptance_owner: "reviewer" },
  repositories: { owner_scope: "FogArmy-LLC", items: [{ name: "paperclip", repo: "FogArmy-LLC/paperclip", purpose: "platform", default_branch: "main", authority_envelope: "manager" }] },
  provider_sync: { enabled: true, profile: "fas", policy_version: "1", update_policy: "auto-apply", conflict_policy: "fail-closed", drift_action: "reconcile", tenant_override_paths: [] },
  delegation: { root_role: "ceo", bootstrap_team_from_roadmap: true, capability_request_path: ["manager", "ceo"], manager_can_expand_within_envelope: true, executive_can_expand_tenant_scope: true, allow_staffing: true, allow_routines: true, allow_internal_key_rotation: true },
  authority_envelopes: { ceo: { capabilities: ["staffing"], approval_ceiling: "tenant" }, manager: { capabilities: ["delegation"], approval_ceiling: "department" }, worker: { capabilities: ["execution"], approval_ceiling: "own-task" }, "independent-reviewer": { capabilities: ["acceptance"], approval_ceiling: "department" } },
  production_delivery: { approval_mode: "autonomous", release_envelope: "micro", versioning: "x.x.y", automatic_rollback: true, rollback_target: "previous-accepted", post_release_acceptance: true },
  reserved_human_decisions: [], acceptance: { require_exact_head_ci: true, require_independent_acceptance: true, require_destination_health: true, require_rollback: true, inheritance_replay: true, false_success_action: "native-recovery" },
});

describe("tenant autonomy bootstrap boundary", () => {
  it("verifies exact source identity and emits a scoped read-only receipt", () => {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const plan = buildTenantAutonomyBootstrapPlan({
      artifact: { sourceRepository: "FogArmy-LLC/fogarmy-platform", sourceCommit: "330c161fbe0fb3e80da6f668c1dbc0d9ea572b83", sourcePath: "infra/paperclip/autonomy/fogarmy.json", sha256, content, authority: "read-only" },
      expectedSource: { repository: "FogArmy-LLC/fogarmy-platform", commit: "330c161fbe0fb3e80da6f668c1dbc0d9ea572b83", path: "infra/paperclip/autonomy/fogarmy.json", sha256 },
      now: new Date("2026-11-08T00:00:00.000Z"), reviewDays: 30,
    });
    expect(plan.binding).toMatchObject({ authority: "read-only", scope: ["FogArmy-LLC/fogarmy-platform", "infra/paperclip/autonomy/fogarmy.json"] });
    expect(plan.graph[0]).toMatchObject({ role: "ceo", parentRole: null });
    expect(plan.repositories).toHaveLength(1);
  });

  it("rejects a reachable artifact with the wrong commit", () => {
    expect(() => buildTenantAutonomyBootstrapPlan({
      artifact: { sourceRepository: "FogArmy-LLC/fogarmy-platform", sourceCommit: "wrong", sourcePath: "infra/paperclip/autonomy/fogarmy.json", sha256: "a".repeat(64), content, authority: "read-only" },
      expectedSource: { repository: "FogArmy-LLC/fogarmy-platform", commit: "330c161fbe0fb3e80da6f668c1dbc0d9ea572b83", path: "infra/paperclip/autonomy/fogarmy.json", sha256: "a".repeat(64) },
    })).toThrow("source identity mismatch");
  });

  it("persists a validated plan as a company-scoped idempotent projection", async () => {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const plan = buildTenantAutonomyBootstrapPlan({
      artifact: { sourceRepository: "FogArmy-LLC/fogarmy-platform", sourceCommit: "330c161fbe0fb3e80da6f668c1dbc0d9ea572b83", sourcePath: "infra/paperclip/autonomy/fogarmy.json", sha256, content, authority: "read-only" },
      expectedSource: { repository: "FogArmy-LLC/fogarmy-platform", commit: "330c161fbe0fb3e80da6f668c1dbc0d9ea572b83", path: "infra/paperclip/autonomy/fogarmy.json", sha256 },
    });
    const chain = {
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: "bootstrap-1" }]),
    };
    const db = { insert: vi.fn(() => chain) } as any;

    await tenantAutonomyService(db).saveBootstrap("company-1", plan);

    expect(db.insert).toHaveBeenCalled();
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      tenantSlug: "fogarmy",
      binding: expect.objectContaining({ authority: "read-only" }),
    }));
    expect(chain.onConflictDoUpdate).toHaveBeenCalled();
  });

  it("bootstrap plan includes only registered repositories in owner scope", () => {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const plan = buildTenantAutonomyBootstrapPlan({
      artifact: { sourceRepository: "FogArmy-LLC/fogarmy-platform", sourceCommit: "330c161fbe0fb3e80da6f668c1dbc0d9ea572b83", sourcePath: "infra/paperclip/autonomy/fogarmy.json", sha256, content, authority: "read-only" },
      expectedSource: { repository: "FogArmy-LLC/fogarmy-platform", commit: "330c161fbe0fb3e80da6f668c1dbc0d9ea572b83", path: "infra/paperclip/autonomy/fogarmy.json", sha256 },
    });
    expect(plan.repositories).toHaveLength(1);
    expect(plan.repositories[0].repo).toBe("FogArmy-LLC/paperclip");
  });

  it("scope guard validates registered repository", () => {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const plan = buildTenantAutonomyBootstrapPlan({
      artifact: { sourceRepository: "FogArmy-LLC/fogarmy-platform", sourceCommit: "330c161fbe0fb3e80da6f668c1dbc0d9ea572b83", sourcePath: "infra/paperclip/autonomy/fogarmy.json", sha256, content, authority: "read-only" },
      expectedSource: { repository: "FogArmy-LLC/fogarmy-platform", commit: "330c161fbe0fb3e80da6f668c1dbc0d9ea572b83", path: "infra/paperclip/autonomy/fogarmy.json", sha256 },
    });
    const result = validateRepositoryInTenantScope(plan.contract, "FogArmy-LLC/paperclip");
    expect(result.allowed).toBe(true);
  });

  it("scope guard rejects unregistered-but-reachable repository", () => {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const plan = buildTenantAutonomyBootstrapPlan({
      artifact: { sourceRepository: "FogArmy-LLC/fogarmy-platform", sourceCommit: "330c161fbe0fb3e80da6f668c1dbc0d9ea572b83", sourcePath: "infra/paperclip/autonomy/fogarmy.json", sha256, content, authority: "read-only" },
      expectedSource: { repository: "FogArmy-LLC/fogarmy-platform", commit: "330c161fbe0fb3e80da6f668c1dbc0d9ea572b83", path: "infra/paperclip/autonomy/fogarmy.json", sha256 },
    });
    const result = validateRepositoryInTenantScope(plan.contract, "FogArmy-LLC/unregistered-repo");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not registered in tenant contract");
  });

  it("scope guard rejects repository outside owner scope", () => {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const plan = buildTenantAutonomyBootstrapPlan({
      artifact: { sourceRepository: "FogArmy-LLC/fogarmy-platform", sourceCommit: "330c161fbe0fb3e80da6f668c1dbc0d9ea572b83", sourcePath: "infra/paperclip/autonomy/fogarmy.json", sha256, content, authority: "read-only" },
      expectedSource: { repository: "FogArmy-LLC/fogarmy-platform", commit: "330c161fbe0fb3e80da6f668c1dbc0d9ea572b83", path: "infra/paperclip/autonomy/fogarmy.json", sha256 },
    });
    const result = validateRepositoryInTenantScope(plan.contract, "external-org/paperclip");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("outside tenant owner scope");
  });
});

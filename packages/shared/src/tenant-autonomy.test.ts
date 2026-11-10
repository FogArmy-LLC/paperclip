import { describe, expect, it } from "vitest";
import {
  capabilityRequestRoute,
  deriveDelegationGraph,
  evaluateProductionDelivery,
  parseTenantAutonomyContract,
  reconcileProviderPolicy,
  validateRepositoryInTenantScope,
} from "./tenant-autonomy.js";

const contract = parseTenantAutonomyContract({
  schema: 1, tenant: { slug: "fogarmy", display_name: "FogArmy", kind: "operator" }, mode: "managed-autonomy",
  objective_contract: { roadmap_owner: "fas-ceo", roadmap_source: "roadmap", outcomes: ["operate"], acceptance_owner: "reviewer" },
  repositories: { owner_scope: "FogArmy-LLC", items: [{ name: "paperclip", repo: "FogArmy-LLC/paperclip", purpose: "platform", default_branch: "main", authority_envelope: "manager" }] },
  provider_sync: { enabled: true, profile: "fas", policy_version: "1", update_policy: "auto-apply", conflict_policy: "fail-closed", drift_action: "reconcile", tenant_override_paths: ["autonomy.production_delivery"] },
  delegation: { root_role: "ceo", bootstrap_team_from_roadmap: true, capability_request_path: ["direct-manager", "accountable-executive", "tenant-ceo"], manager_can_expand_within_envelope: true, executive_can_expand_tenant_scope: true, allow_staffing: true, allow_routines: true, allow_internal_key_rotation: true },
  authority_envelopes: {
    ceo: { capabilities: ["staffing"], approval_ceiling: "tenant" }, manager: { capabilities: ["delegation"], approval_ceiling: "department" },
    worker: { capabilities: ["execution"], approval_ceiling: "own-task" }, "independent-reviewer": { capabilities: ["acceptance"], approval_ceiling: "department" },
  },
  production_delivery: { approval_mode: "autonomous", release_envelope: "micro", versioning: "x.x.y", automatic_rollback: true, rollback_target: "previous-accepted", post_release_acceptance: true },
  reserved_human_decisions: ["destructive-deletion"], acceptance: { require_exact_head_ci: true, require_independent_acceptance: true, require_destination_health: true, require_rollback: true, inheritance_replay: true, false_success_action: "native-recovery" },
});

describe("tenant autonomy contract", () => {
  it("derives a CEO-rooted graph and manager escalation route", () => {
    expect(deriveDelegationGraph(contract).map((node) => node.role)).toEqual(["ceo", "manager", "worker", "independent-reviewer"]);
    expect(capabilityRequestRoute(contract, "direct-manager")).toEqual(["direct-manager", "accountable-executive", "tenant-ceo"]);
  });

  it("preserves tenant overrides and fails closed on provider conflicts", () => {
    const result = reconcileProviderPolicy(contract, { autonomy: { production_delivery: { approval_mode: "human" } } }, { autonomy: { production_delivery: { approval_mode: "autonomous" } } });
    expect(result.action).toBe("failed-closed");
    expect(result.preservedOverridePaths).toEqual(["autonomy.production_delivery"]);
    expect(result.policy.autonomy).toEqual({ production_delivery: { approval_mode: "autonomous" } });
  });

  it("requires independent acceptance and rolls back incomplete delivery", () => {
    expect(evaluateProductionDelivery({ contract, exactHeadCi: true, destinationHealthy: true, independentAcceptance: true, rollbackObserved: false }).decision).toBe("release");
    expect(evaluateProductionDelivery({ contract, exactHeadCi: true, destinationHealthy: false, independentAcceptance: false, rollbackObserved: true }).decision).toBe("rollback");
  });

  it("validates registered repositories in tenant scope", () => {
    const result = validateRepositoryInTenantScope(contract, "FogArmy-LLC/paperclip");
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("repository registered in tenant scope");
  });

  it("rejects unregistered repositories with deterministic reason", () => {
    const result = validateRepositoryInTenantScope(contract, "FogArmy-LLC/not-registered");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("repository not registered in tenant contract: FogArmy-LLC/not-registered");
  });

  it("rejects repositories outside owner scope with deterministic reason", () => {
    const result = validateRepositoryInTenantScope(contract, "other-owner/paperclip");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("repository outside tenant owner scope: other-owner/paperclip not under FogArmy-LLC");
  });

  it("rejects malformed repository identifiers", () => {
    const result = validateRepositoryInTenantScope(contract, "invalid-repo");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("invalid repository format: must be owner/name");
  });
});

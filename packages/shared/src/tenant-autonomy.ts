import { z } from "zod";

const repositorySchema = z.object({
  name: z.string().min(1),
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  purpose: z.string().min(1),
  default_branch: z.string().min(1),
  authority_envelope: z.enum(["manager", "ceo"]),
}).strict();

const authorityEnvelopeSchema = z.object({
  capabilities: z.array(z.string().min(1)).min(1),
  approval_ceiling: z.enum(["own-task", "department", "tenant"]),
}).strict();

export const tenantAutonomyContractSchema = z.object({
  schema: z.literal(1),
  tenant: z.object({
    slug: z.string().min(1),
    display_name: z.string().min(1),
    kind: z.string().min(1),
  }).strict(),
  mode: z.literal("managed-autonomy"),
  objective_contract: z.object({
    roadmap_owner: z.string().min(1),
    roadmap_source: z.string().min(1),
    outcomes: z.array(z.string().min(1)).min(1),
    acceptance_owner: z.string().min(1),
  }).strict(),
  repositories: z.object({
    owner_scope: z.string().min(1),
    items: z.array(repositorySchema).min(1),
  }).strict(),
  provider_sync: z.object({
    enabled: z.boolean(),
    profile: z.string().min(1),
    policy_version: z.string().min(1),
    update_policy: z.enum(["observe", "propose", "auto-apply"]),
    conflict_policy: z.literal("fail-closed"),
    drift_action: z.enum(["report", "reconcile"]),
    tenant_override_paths: z.array(z.string().min(1)),
  }).strict(),
  delegation: z.object({
    root_role: z.literal("ceo"),
    bootstrap_team_from_roadmap: z.boolean(),
    capability_request_path: z.array(z.string().min(1)).min(1),
    manager_can_expand_within_envelope: z.boolean(),
    executive_can_expand_tenant_scope: z.boolean(),
    allow_staffing: z.boolean(),
    allow_routines: z.boolean(),
    allow_internal_key_rotation: z.boolean(),
  }).strict(),
  authority_envelopes: z.object({
    ceo: authorityEnvelopeSchema,
    manager: authorityEnvelopeSchema,
    worker: authorityEnvelopeSchema,
    "independent-reviewer": authorityEnvelopeSchema,
  }).strict(),
  production_delivery: z.object({
    approval_mode: z.literal("autonomous"),
    release_envelope: z.literal("micro"),
    versioning: z.literal("x.x.y"),
    automatic_rollback: z.literal(true),
    rollback_target: z.literal("previous-accepted"),
    post_release_acceptance: z.literal(true),
  }).strict(),
  reserved_human_decisions: z.array(z.string().min(1)),
  acceptance: z.object({
    require_exact_head_ci: z.literal(true),
    require_independent_acceptance: z.literal(true),
    require_destination_health: z.literal(true),
    require_rollback: z.literal(true),
    inheritance_replay: z.literal(true),
    false_success_action: z.literal("native-recovery"),
  }).strict(),
}).strict();

export type TenantAutonomyContract = z.infer<typeof tenantAutonomyContractSchema>;

export type DelegationNode = {
  role: keyof TenantAutonomyContract["authority_envelopes"];
  capabilities: string[];
  approvalCeiling: "own-task" | "department" | "tenant";
  parentRole: DelegationNode["role"] | null;
};

export function parseTenantAutonomyContract(value: unknown): TenantAutonomyContract {
  const contract = tenantAutonomyContractSchema.parse(value);
  const repos = new Set<string>();
  for (const item of contract.repositories.items) {
    if (repos.has(item.repo)) throw new Error(`duplicate tenant repository: ${item.repo}`);
    repos.add(item.repo);
    if (!item.repo.startsWith(`${contract.repositories.owner_scope}/`)) {
      throw new Error(`repository outside tenant owner scope: ${item.repo}`);
    }
  }
  return contract;
}

/** Derive the minimum CEO-rooted graph; product roadmap roles may add descendants later. */
export function deriveDelegationGraph(contract: TenantAutonomyContract): DelegationNode[] {
  const order: DelegationNode["role"][] = ["ceo", "manager", "worker", "independent-reviewer"];
  return order.map((role) => ({
    role,
    capabilities: [...contract.authority_envelopes[role].capabilities],
    approvalCeiling: contract.authority_envelopes[role].approval_ceiling,
    parentRole: role === "ceo" ? null : role === "manager" ? "ceo" : "manager",
  }));
}

export function capabilityRequestRoute(contract: TenantAutonomyContract, requesterRole: string): string[] {
  if (!contract.delegation.capability_request_path.includes(requesterRole)) {
    return [requesterRole, ...contract.delegation.capability_request_path];
  }
  return contract.delegation.capability_request_path.slice(
    contract.delegation.capability_request_path.indexOf(requesterRole),
  );
}

export type ProviderPolicyReconciliation = {
  policy: Record<string, unknown>;
  preservedOverridePaths: string[];
  conflicts: string[];
  action: "reconciled" | "failed-closed" | "disabled";
};

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => (
    current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined
  ), value);
}

function setPath(value: Record<string, unknown>, path: string, next: unknown): void {
  const parts = path.split(".");
  let current = value;
  for (const part of parts.slice(0, -1)) {
    const child = current[part];
    if (!child || typeof child !== "object" || Array.isArray(child)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts.at(-1)!] = next;
}

/** Apply provider defaults without overwriting declared tenant-owned paths. */
export function reconcileProviderPolicy(
  contract: TenantAutonomyContract,
  providerPolicy: Record<string, unknown>,
  currentTenantPolicy: Record<string, unknown>,
): ProviderPolicyReconciliation {
  if (!contract.provider_sync.enabled) return { policy: { ...currentTenantPolicy }, preservedOverridePaths: [], conflicts: [], action: "disabled" };
  const policy = structuredClone(providerPolicy);
  const conflicts: string[] = [];
  const preservedOverridePaths: string[] = [];
  for (const path of contract.provider_sync.tenant_override_paths) {
    const override = getPath(currentTenantPolicy, path);
    const providerValue = getPath(providerPolicy, path);
    if (override !== undefined) {
      if (providerValue !== undefined && JSON.stringify(override) !== JSON.stringify(providerValue)) conflicts.push(path);
      setPath(policy, path, override);
      preservedOverridePaths.push(path);
    }
  }
  if (conflicts.length > 0) return { policy, preservedOverridePaths, conflicts, action: "failed-closed" };
  return { policy, preservedOverridePaths, conflicts, action: "reconciled" };
}

export type ProductionDeliveryDecision = "release" | "rollback" | "reject";

export function evaluateProductionDelivery(input: {
  contract: TenantAutonomyContract;
  exactHeadCi: boolean;
  destinationHealthy: boolean;
  independentAcceptance: boolean;
  rollbackObserved: boolean;
}): { decision: ProductionDeliveryDecision; reason: string } {
  const { contract } = input;
  if (!contract.production_delivery.post_release_acceptance || !contract.production_delivery.automatic_rollback) {
    return { decision: "reject", reason: "production delivery contract is incomplete" };
  }
  if (input.exactHeadCi && input.destinationHealthy && input.independentAcceptance) {
    return { decision: "release", reason: "autonomous micro release accepted independently" };
  }
  if (input.rollbackObserved) return { decision: "rollback", reason: "acceptance failed; restore previous accepted release" };
  return { decision: "reject", reason: "acceptance evidence incomplete; no release authority" };
}

export type RepositoryScopeGuardResult = {
  allowed: boolean;
  reason: string;
};

/** Validate that a repository is registered under the tenant's owner scope. */
export function validateRepositoryInTenantScope(
  contract: TenantAutonomyContract,
  repository: string,
): RepositoryScopeGuardResult {
  if (!repository || !repository.includes("/")) {
    return { allowed: false, reason: "invalid repository format: must be owner/name" };
  }

  const ownerScope = contract.repositories.owner_scope;
  if (!repository.startsWith(`${ownerScope}/`)) {
    return { allowed: false, reason: `repository outside tenant owner scope: ${repository} not under ${ownerScope}` };
  }

  const registeredRepos = contract.repositories.items.map((item) => item.repo);
  if (!registeredRepos.includes(repository)) {
    return { allowed: false, reason: `repository not registered in tenant contract: ${repository}` };
  }

  return { allowed: true, reason: "repository registered in tenant scope" };
}

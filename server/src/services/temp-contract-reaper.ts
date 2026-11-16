import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { agents, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { createAgentLifecycle } from "./agent-lifecycle.js";
import { logActivity } from "./activity-log.js";

const ACTIVE_RUN_STATUSES = ["queued", "claimed", "running"] as const;
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

export interface ParsedTempContractLease {
  kind: "temp";
  reason: "sla_surge" | "provider_failover";
  hiredByAgentId: string | null;
  boundIssueId: string | null;
  ttlMinutes: number | null;
  maxIdleMinutes: number | null;
  leasedAt: string | null;
  expiresAt: string | null;
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return typeof val === "object" && val !== null && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

export function readTempContractLease(runtimeConfig: unknown): ParsedTempContractLease | null {
  const rc = asRecord(runtimeConfig);
  const lease = asRecord(rc?.contractLease);
  if (!lease || lease.kind !== "temp") return null;
  const reason = lease.reason === "provider_failover" ? "provider_failover" : "sla_surge";
  const strOrNull = (v: unknown) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
  const posIntOrNull = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
  return {
    kind: "temp",
    reason,
    hiredByAgentId: strOrNull(lease.hiredByAgentId),
    boundIssueId: strOrNull(lease.boundIssueId),
    ttlMinutes: posIntOrNull(lease.ttlMinutes),
    maxIdleMinutes: posIntOrNull(lease.maxIdleMinutes),
    leasedAt: strOrNull(lease.leasedAt),
    expiresAt: strOrNull(lease.expiresAt),
  };
}

export interface TempContractReapItem {
  agentId: string;
  companyId: string;
  reason: "ttl_expired" | "idle_exceeded" | "bound_issue_closed";
}

export function evaluateTempContractExpiry(input: {
  lease: ParsedTempContractLease;
  createdAt: Date;
  lastHeartbeatAt: Date | null;
  boundIssueStatus: string | null;
  now: Date;
}): "ttl_expired" | "idle_exceeded" | "bound_issue_closed" | null {
  const nowMs = input.now.getTime();
  if (input.lease.boundIssueId && input.boundIssueStatus && TERMINAL_ISSUE_STATUSES.has(input.boundIssueStatus)) {
    return "bound_issue_closed";
  }
  if (input.lease.expiresAt) {
    const expMs = Date.parse(input.lease.expiresAt);
    if (Number.isFinite(expMs) && nowMs >= expMs) {
      return "ttl_expired";
    }
  } else if (input.lease.ttlMinutes !== null) {
    const baseMs = input.lease.leasedAt ? Date.parse(input.lease.leasedAt) : input.createdAt.getTime();
    if (Number.isFinite(baseMs) && nowMs - baseMs >= input.lease.ttlMinutes * 60_000) {
      return "ttl_expired";
    }
  }
  if (input.lease.maxIdleMinutes !== null) {
    const lastActiveMs = Math.max(
      input.createdAt.getTime(),
      input.lastHeartbeatAt ? input.lastHeartbeatAt.getTime() : 0,
      input.lease.leasedAt && Number.isFinite(Date.parse(input.lease.leasedAt))
        ? Date.parse(input.lease.leasedAt)
        : 0,
    );
    if (nowMs - lastActiveMs >= input.lease.maxIdleMinutes * 60_000) {
      return "idle_exceeded";
    }
  }
  return null;
}

export function tempContractReaperService(
  db: Db,
  deps: {
    cancelInvocationsForAgents?: (
      agentIds: string[],
      reason: string,
    ) => Promise<{ agentIds: string[]; runsCancelled: number; wakeupsCancelled: number }>;
    cancelWorkForScope?: (scope: { companyId: string; agentId?: string }) => Promise<void>;
  } = {},
) {
  const lifecycle = createAgentLifecycle(db, {
    cancelWorkForScope: deps.cancelWorkForScope ?? (async () => {}),
  });

  async function reapExpiredTempContracts(options: {
    companyId?: string;
    now?: Date;
  } = {}): Promise<{ checked: number; reaped: number; items: TempContractReapItem[] }> {
    const now = options.now ?? new Date();
    const companyFilter = options.companyId
      ? and(isNull(companies.archivedAt), eq(companies.id, options.companyId))
      : isNull(companies.archivedAt);

    const rows = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        status: agents.status,
        runtimeConfig: agents.runtimeConfig,
        createdAt: agents.createdAt,
        lastHeartbeatAt: agents.lastHeartbeatAt,
      })
      .from(agents)
      .innerJoin(companies, eq(agents.companyId, companies.id))
      .where(and(companyFilter, ne(agents.status, "terminated")));

    const tempCandidates = rows
      .map((row) => ({ row, lease: readTempContractLease(row.runtimeConfig) }))
      .filter((entry): entry is { row: (typeof rows)[number]; lease: ParsedTempContractLease } => entry.lease !== null);

    if (tempCandidates.length === 0) {
      return { checked: 0, reaped: 0, items: [] };
    }

    const candidateAgentIds = tempCandidates.map((c) => c.row.id);
    const activeRunRows = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(
        and(
          inArray(heartbeatRuns.agentId, candidateAgentIds),
          inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
        ),
      );
    const busyAgentIds = new Set(activeRunRows.map((r) => r.agentId));

    const boundIssueIds = [
      ...new Set(
        tempCandidates
          .map((c) => c.lease.boundIssueId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const issueStatusById = new Map<string, string>();
    if (boundIssueIds.length > 0) {
      const issueRows = await db
        .select({ id: issues.id, status: issues.status })
        .from(issues)
        .where(inArray(issues.id, boundIssueIds));
      for (const issue of issueRows) {
        issueStatusById.set(issue.id, issue.status);
      }
    }

    const reapedItems: TempContractReapItem[] = [];
    for (const { row, lease } of tempCandidates) {
      if (busyAgentIds.has(row.id)) continue;
      const reason = evaluateTempContractExpiry({
        lease,
        createdAt: row.createdAt,
        lastHeartbeatAt: row.lastHeartbeatAt,
        boundIssueStatus: lease.boundIssueId ? (issueStatusById.get(lease.boundIssueId) ?? null) : null,
        now,
      });
      if (!reason) continue;

      const terminated = await lifecycle.terminateAgent(row.id);
      if (!terminated) continue;

      if (deps.cancelInvocationsForAgents) {
        await deps.cancelInvocationsForAgents(
          [row.id],
          `Cancelled because temporary contractor lease expired (${reason})`,
        );
      }

      await logActivity(db, {
        companyId: row.companyId,
        actorType: "system",
        actorId: "temp_contract_reaper",
        action: "agent.temp_contract_reaped",
        entityType: "agent",
        entityId: row.id,
        details: {
          reason,
          hiredByAgentId: lease.hiredByAgentId,
          boundIssueId: lease.boundIssueId,
          expiresAt: lease.expiresAt,
          maxIdleMinutes: lease.maxIdleMinutes,
        },
      });

      reapedItems.push({ agentId: row.id, companyId: row.companyId, reason });
    }

    return {
      checked: tempCandidates.length,
      reaped: reapedItems.length,
      items: reapedItems,
    };
  }

  return { reapExpiredTempContracts };
}

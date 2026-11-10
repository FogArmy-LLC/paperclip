import {
  issues,
  issueComments,
  heartbeatRuns,
  companies,
  agentWakeupRequests,
  agentTaskSessions,
  agentSessionGoalActions,
  agents,
  toolCallEvents,
  toolConnections,
  connectionGrants,
  issueRecoveryActions,
  workspaceOperations,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  type IssueExecutionMonitorPolicy,
  type IssueExecutionMonitorClearReason,
  type IssueExecutionMonitorRecoveryPolicy,
  PROVIDER_QUOTA_MONITOR_SERVICE_NAME,
  isUuidLike,
} from "@paperclipai/shared";
import {
  and,
  eq,
  notInArray,
  desc,
  sql,
  isNull,
  inArray,
  or,
  lt,
  lte,
  asc,
  getTableColumns,
  gt,
  gte,
} from "drizzle-orm";
import { RECOVERY_ORIGIN_KINDS } from "../recovery/index.js";
import { visibleIssueCondition } from "../issue-visibility.js";
import { REVIEW_PATH_RECOVERY_INSTRUCTION } from "../recovery/review-path-recovery.js";
import { withRecoveryContext } from "../recovery/status-only-context.js";
import { logActivity } from "../activity-log.js";
import {
  normalizeIssueExecutionPolicy,
  buildIssueMonitorClearedPatch,
  parseIssueExecutionState,
  buildIssueMonitorTriggeredPatch,
} from "../issue-execution-policy.js";
import { conflict, HttpError, notFound } from "../../errors.js";
import { EXECUTION_REVIEW_PARTICIPANT_RECOVERY_WAKE_REASON } from "./run-state.js";
import { parseObject } from "../../adapters/utils.js";
import {
  legacyExecutionNeedsReconciliationWithEvidence,
  terminalizeLegacyExecution,
} from "../legacy-execution-recovery.js";
import { logger } from "../../middleware/logger.js";
import { failRunnerGoalAction } from "../runner-goals.js";
import { evaluateAgentInvokability } from "../agent-invokability.js";
import { issueReadSqlCondition } from "../authorization.js";
import {
  executionSlaRetryDue,
  executionSlaStage,
  matchingExecutionSlaCapabilityReceipt,
} from "../execution-sla.js";
import { toolAccessService } from "../tool-access.js";
import type { Db } from "@paperclipai/db";
import type { issueService } from "../issues.js";
import type { createHeartbeatQueue } from "./queue.js";
import type { createHeartbeatRetries, HeartbeatRetryDependencies } from "./retries.js";
import type { createHeartbeatRunPreparation } from "./run-preparation.js";
import type { NativeSessionGoalControl } from "../../vendor/paperclip-runner/index.js";

type HeartbeatQueue = ReturnType<typeof createHeartbeatQueue>;
type RunPreparation = ReturnType<typeof createHeartbeatRunPreparation>;

export interface HeartbeatSchedulingDependencies
  extends Pick<HeartbeatRetryDependencies, "getRun" | "getAgent" | "getWorktreeExecutionCutoff">,
    Pick<HeartbeatQueue, "enqueueWakeup" | "parseHeartbeatPolicy" | "claimDueTimerHeartbeat">,
    Pick<RunPreparation, "toAgentOrgRow" | "groupAgentOrgRowsByCompany"> {
  issuesSvc: Pick<ReturnType<typeof issueService>, "listReviewAttention" | "create" | "updateForCompany">;
  scheduleBoundedRetryForRun: ReturnType<typeof createHeartbeatRetries>["scheduleBoundedRetryForRun"];
  getSchedulingSuppression: () => Promise<{ suppressed: boolean }>;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function parseNativeSessionGoalControl(
  value: unknown,
): NativeSessionGoalControl | null {
  const candidate = parseObject(value);
  const requestId = readNonEmptyString(candidate.requestId);
  const action = readNonEmptyString(candidate.action);
  if (
    !requestId ||
    !action ||
    !["create", "edit", "replace", "pause", "resume", "clear"].includes(action)
  )
    return null;
  const objective = readNonEmptyString(candidate.objective);
  const tokenBudget =
    candidate.tokenBudget === null
      ? null
      : typeof candidate.tokenBudget === "number" &&
          Number.isSafeInteger(candidate.tokenBudget) &&
          candidate.tokenBudget > 0
        ? candidate.tokenBudget
        : undefined;
  return {
    requestId,
    action: action as NativeSessionGoalControl["action"],
    ...(objective ? { objective } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
  };
}

export function formatIssueIdentifierLink(
  identifier: string | null,
  fallback: string,
) {
  if (!identifier) return fallback;
  const prefix = identifier.split("-")[0];
  if (!prefix || !/^[A-Z][A-Z0-9]*-\d+$/.test(identifier)) return identifier;
  return `[${identifier}](/${prefix}/issues/${identifier})`;
}

const EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON =
  "execution_review_participant_recovery";

// Construction only binds dependencies. Scheduler calls retain the existing queue admission gates.
export function createHeartbeatScheduling(
  db: Db,
  dependencies: HeartbeatSchedulingDependencies,
) {
  const {
    issuesSvc,
    enqueueWakeup,
    getRun,
    getAgent,
    scheduleBoundedRetryForRun,
    getSchedulingSuppression,
    getWorktreeExecutionCutoff,
    toAgentOrgRow,
    groupAgentOrgRowsByCompany,
    parseHeartbeatPolicy,
    claimDueTimerHeartbeat,
  } = dependencies;

  const issueMonitorDispatchColumns = {
    id: issues.id,
    companyId: issues.companyId,
    projectId: issues.projectId,
    goalId: issues.goalId,
    identifier: issues.identifier,
    title: issues.title,
    status: issues.status,
    priority: issues.priority,
    assigneeAgentId: issues.assigneeAgentId,
    assigneeUserId: issues.assigneeUserId,
    billingCode: issues.billingCode,
    executionPolicy: issues.executionPolicy,
    executionState: issues.executionState,
    monitorNextCheckAt: issues.monitorNextCheckAt,
    monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
    monitorLastTriggeredAt: issues.monitorLastTriggeredAt,
    monitorAttemptCount: issues.monitorAttemptCount,
    monitorNotes: issues.monitorNotes,
    monitorScheduledBy: issues.monitorScheduledBy,
  };

  interface IssueMonitorDispatchRow {
    id: string;
    companyId: string;
    projectId: string | null;
    goalId: string | null;
    identifier: string | null;
    title: string;
    status: string;
    priority: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    billingCode: string | null;
    executionPolicy: Record<string, unknown> | null;
    executionState: Record<string, unknown> | null;
    monitorNextCheckAt: Date | null;
    monitorWakeRequestedAt: Date | null;
    monitorLastTriggeredAt: Date | null;
    monitorAttemptCount: number | null;
    monitorNotes: string | null;
    monitorScheduledBy: string | null;
  }

  function parseMonitorDate(value: string | null | undefined) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function issueMonitorLimitClearReason(input: {
    monitor: IssueExecutionMonitorPolicy | null;
    nextAttemptCount: number;
    now: Date;
  }): IssueExecutionMonitorClearReason | null {
    const timeoutAt = parseMonitorDate(input.monitor?.timeoutAt ?? null);
    if (timeoutAt && input.now.getTime() >= timeoutAt.getTime()) {
      return "timeout_exceeded";
    }
    const maxAttempts = input.monitor?.maxAttempts ?? null;
    if (maxAttempts !== null && input.nextAttemptCount > maxAttempts) {
      return "max_attempts_exhausted";
    }
    return null;
  }

  function monitorRecoveryPolicy(
    monitor: IssueExecutionMonitorPolicy | null,
  ): IssueExecutionMonitorRecoveryPolicy {
    return monitor?.recoveryPolicy ?? "wake_owner";
  }

  function monitorRecoveryDetails(input: {
    claimed: IssueMonitorDispatchRow;
    scheduledAtIso: string;
    nextAttemptCount: number;
    clearReason: IssueExecutionMonitorClearReason;
    recoveryPolicy: IssueExecutionMonitorRecoveryPolicy;
    monitor: IssueExecutionMonitorPolicy | null;
    source: "manual" | "scheduled";
  }) {
    return {
      identifier: input.claimed.identifier,
      nextCheckAt: input.scheduledAtIso,
      attemptedAttemptCount: input.nextAttemptCount,
      notes: input.claimed.monitorNotes ?? null,
      serviceName: input.monitor?.serviceName ?? null,
      timeoutAt: input.monitor?.timeoutAt ?? null,
      maxAttempts: input.monitor?.maxAttempts ?? null,
      clearReason: input.clearReason,
      recoveryPolicy: input.recoveryPolicy,
      source: input.source,
    };
  }


  function monitorRecoveryComment(input: {
    issue: IssueMonitorDispatchRow;
    clearReason: IssueExecutionMonitorClearReason;
    recoveryPolicy: IssueExecutionMonitorRecoveryPolicy;
    nextAttemptCount: number;
  }) {
    const label = formatIssueIdentifierLink(
      input.issue.identifier,
      input.issue.id,
    );
    const reason =
      input.clearReason === "timeout_exceeded"
        ? "its timeout was reached"
        : "its maximum attempt count was reached";
    return [
      `Paperclip cleared the scheduled external-service monitor for ${label} because ${reason}.`,
      "",
      `- Attempt count: ${input.nextAttemptCount}`,
      `- Recovery policy: ${input.recoveryPolicy}`,
      "",
      "Next action: inspect the external service state, record the result on this issue, and restore an explicit execution or waiting path if more work remains.",
    ].join("\n");
  }

  async function findOpenIssueMonitorRecoveryIssue(
    claimed: IssueMonitorDispatchRow,
  ) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, claimed.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.strandedIssueRecovery),
          eq(issues.originId, claimed.id),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function performIssueMonitorRecovery(input: {
    claimed: IssueMonitorDispatchRow;
    scheduledAtIso: string;
    nextAttemptCount: number;
    clearReason: IssueExecutionMonitorClearReason;
    recoveryPolicy: IssueExecutionMonitorRecoveryPolicy;
    monitor: IssueExecutionMonitorPolicy | null;
    actorType: "user" | "agent" | "system";
    actorId: string;
    agentId: string | null;
    runId: string | null;
    activitySource: "manual" | "scheduled";
  }) {
    const reviewPathLost =
      input.claimed.status === "in_review" &&
      (await issuesSvc
        .listReviewAttention(input.claimed.companyId, [input.claimed])
        .then(
          (attention) => attention.get(input.claimed.id)?.state === "stalled",
        ));
    const reviewPathContext = reviewPathLost
      ? {
          reviewPathLost: true,
          reviewPathConsumedRef: `monitor:${input.claimed.id}:${input.clearReason}:${input.scheduledAtIso}`,
          reviewPathInstruction: REVIEW_PATH_RECOVERY_INSTRUCTION,
        }
      : null;
    const details = monitorRecoveryDetails({
      claimed: input.claimed,
      scheduledAtIso: input.scheduledAtIso,
      nextAttemptCount: input.nextAttemptCount,
      clearReason: input.clearReason,
      recoveryPolicy: input.recoveryPolicy,
      monitor: input.monitor,
      source: input.activitySource,
    });

    if (input.recoveryPolicy === "create_recovery_issue") {
      let recoveryIssue = await findOpenIssueMonitorRecoveryIssue(
        input.claimed,
      );
      if (!recoveryIssue) {
        recoveryIssue = await issuesSvc.create(input.claimed.companyId, {
          title: `Recover external-service monitor for ${input.claimed.identifier ?? input.claimed.title}`,
          description: monitorRecoveryComment({
            issue: input.claimed,
            clearReason: input.clearReason,
            recoveryPolicy: input.recoveryPolicy,
            nextAttemptCount: input.nextAttemptCount,
          }),
          status: "todo",
          priority: "high",
          parentId: input.claimed.id,
          projectId: input.claimed.projectId,
          goalId: input.claimed.goalId,
          assigneeAgentId: input.claimed.assigneeAgentId,
          originKind: RECOVERY_ORIGIN_KINDS.strandedIssueRecovery,
          originId: input.claimed.id,
          originFingerprint: `issue_monitor:${input.clearReason}`,
          billingCode: input.claimed.billingCode,
        });
      }

      if (recoveryIssue.assigneeAgentId) {
        await enqueueWakeup(recoveryIssue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_monitor_recovery_issue",
          idempotencyKey: `issue-monitor-recovery-issue:${input.claimed.id}:${input.clearReason}:${input.scheduledAtIso}`,
          payload: withRecoveryContext(
            { issueId: recoveryIssue.id, sourceIssueId: input.claimed.id },
            "status_only",
          ),
          requestedByActorType: input.actorType,
          requestedByActorId: input.actorId,
          contextSnapshot: withRecoveryContext(
            {
              issueId: recoveryIssue.id,
              sourceIssueId: input.claimed.id,
              source: "issue.monitor.recovery_issue",
              wakeReason: "issue_monitor_recovery_issue",
            },
            "status_only",
          ),
        });
      }

      await logActivity(db, {
        companyId: input.claimed.companyId,
        actorType: input.actorType,
        actorId: input.actorId,
        agentId: input.agentId,
        runId: input.runId,
        action: "issue.monitor_recovery_issue_created",
        entityType: "issue",
        entityId: input.claimed.id,
        details: {
          ...details,
          recoveryIssueId: recoveryIssue.id,
          recoveryIdentifier: recoveryIssue.identifier,
        },
      });
      return;
    }

    if (input.recoveryPolicy === "escalate_to_board") {
      await db.insert(issueComments).values({
        companyId: input.claimed.companyId,
        issueId: input.claimed.id,
        body: monitorRecoveryComment({
          issue: input.claimed,
          clearReason: input.clearReason,
          recoveryPolicy: input.recoveryPolicy,
          nextAttemptCount: input.nextAttemptCount,
        }),
      });

      await logActivity(db, {
        companyId: input.claimed.companyId,
        actorType: input.actorType,
        actorId: input.actorId,
        agentId: input.agentId,
        runId: input.runId,
        action: "issue.monitor_escalated_to_board",
        entityType: "issue",
        entityId: input.claimed.id,
        details,
      });
      return;
    }

    await enqueueWakeup(input.claimed.assigneeAgentId!, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_monitor_recovery",
      idempotencyKey: `issue-monitor-recovery:${input.claimed.id}:${input.clearReason}:${input.scheduledAtIso}`,
      payload: withRecoveryContext(
        {
          issueId: input.claimed.id,
          monitorAttemptCount: input.nextAttemptCount,
          monitorNotes: input.claimed.monitorNotes ?? null,
          clearReason: input.clearReason,
          serviceName: input.monitor?.serviceName ?? null,
          timeoutAt: input.monitor?.timeoutAt ?? null,
          maxAttempts: input.monitor?.maxAttempts ?? null,
          ...(reviewPathContext ?? {}),
        },
        "status_only",
      ),
      requestedByActorType: input.actorType,
      requestedByActorId: input.actorId,
      contextSnapshot: withRecoveryContext(
        {
          issueId: input.claimed.id,
          source: "issue.monitor.recovery",
          wakeReason: "issue_monitor_recovery",
          monitorAttemptCount: input.nextAttemptCount,
          monitorNotes: input.claimed.monitorNotes ?? null,
          clearReason: input.clearReason,
          serviceName: input.monitor?.serviceName ?? null,
          timeoutAt: input.monitor?.timeoutAt ?? null,
          maxAttempts: input.monitor?.maxAttempts ?? null,
          ...(reviewPathContext ?? {}),
        },
        "status_only",
      ),
    });

    await logActivity(db, {
      companyId: input.claimed.companyId,
      actorType: input.actorType,
      actorId: input.actorId,
      agentId: input.agentId,
      runId: input.runId,
      action: "issue.monitor_recovery_wake_queued",
      entityType: "issue",
      entityId: input.claimed.id,
      details,
    });
  }

  async function clearIssueMonitorAndRecover(input: {
    claimed: IssueMonitorDispatchRow;
    policy: ReturnType<typeof normalizeIssueExecutionPolicy>;
    scheduledAtIso: string;
    nextAttemptCount: number;
    clearReason: IssueExecutionMonitorClearReason;
    recoveryPolicy: IssueExecutionMonitorRecoveryPolicy;
    monitor: IssueExecutionMonitorPolicy | null;
    now: Date;
    actorType: "user" | "agent" | "system";
    actorId: string;
    agentId: string | null;
    runId: string | null;
    activitySource: "manual" | "scheduled";
  }) {
    const cleared = await db
      .update(issues)
      .set({
        ...monitorOnlyDispatchPatch(buildIssueMonitorClearedPatch({
          issue: input.claimed,
          policy: input.policy,
          clearReason: input.clearReason,
          clearedAt: input.now,
        })),
        updatedAt: input.now,
      })
      .where(issueMonitorClaimCondition(input.claimed)).returning({ id: issues.id });
    if (cleared.length === 0) return { outcome: "skipped" as const, reason: "monitor_replaced" };

    await logActivity(db, {
      companyId: input.claimed.companyId,
      actorType: input.actorType,
      actorId: input.actorId,
      agentId: input.agentId,
      runId: input.runId,
      action: "issue.monitor_exhausted",
      entityType: "issue",
      entityId: input.claimed.id,
      details: monitorRecoveryDetails({
        claimed: input.claimed,
        scheduledAtIso: input.scheduledAtIso,
        nextAttemptCount: input.nextAttemptCount,
        clearReason: input.clearReason,
        recoveryPolicy: input.recoveryPolicy,
        monitor: input.monitor,
        source: input.activitySource,
      }),
    });

    await performIssueMonitorRecovery({
      claimed: input.claimed,
      scheduledAtIso: input.scheduledAtIso,
      nextAttemptCount: input.nextAttemptCount,
      clearReason: input.clearReason,
      recoveryPolicy: input.recoveryPolicy,
      monitor: input.monitor,
      actorType: input.actorType,
      actorId: input.actorId,
      agentId: input.agentId,
      runId: input.runId,
      activitySource: input.activitySource,
    });

    return { outcome: "skipped" as const, reason: input.clearReason };
  }

  function monitorOnlyDispatchPatch<T extends ReturnType<typeof buildIssueMonitorClearedPatch>>(patch: T) {
    // Admission and consumption are separate transactions. Preserve any review
    // policy/state changes made between them; only the monitor belongs to us.
    return {
      ...patch,
      executionPolicy: sql`nullif(${issues.executionPolicy} - 'monitor', '{}'::jsonb)`,
      executionState: sql`jsonb_set(coalesce(${issues.executionState}, ${JSON.stringify(patch.executionState)}::jsonb),
        '{monitor}', ${JSON.stringify(patch.executionState?.monitor ?? null)}::jsonb)`,
    };
  }

  function issueMonitorClaimCondition(claimed: IssueMonitorDispatchRow) {
    return and(eq(issues.id, claimed.id), eq(issues.companyId, claimed.companyId),
      eq(issues.assigneeAgentId, claimed.assigneeAgentId!), isNull(issues.assigneeUserId),
      eq(issues.status, claimed.status), eq(issues.monitorNextCheckAt, claimed.monitorNextCheckAt!),
      eq(issues.monitorWakeRequestedAt, claimed.monitorWakeRequestedAt!));
  }

  async function dispatchClaimedIssueMonitor(
    claimed: IssueMonitorDispatchRow,
    input: {
      now: Date;
      source: "automation" | "on_demand";
      triggerDetail: "manual" | "system";
      wakeReason: string;
      actorType: "user" | "agent" | "system";
      actorId: string;
      agentId: string | null;
      runId: string | null;
      clearOnClientError: boolean;
      activitySource: "manual" | "scheduled";
    },
  ) {
    if (!claimed.assigneeAgentId || !claimed.monitorNextCheckAt) {
      throw conflict("Issue monitor is not ready to dispatch");
    }

    const scheduledAtIso = claimed.monitorNextCheckAt.toISOString();
    const nextAttemptCount = (claimed.monitorAttemptCount ?? 0) + 1;
    const policy = normalizeIssueExecutionPolicy(
      claimed.executionPolicy ?? null,
    );
    const monitor = policy?.monitor ?? null;
    const clearReason = issueMonitorLimitClearReason({
      monitor,
      nextAttemptCount,
      now: input.now,
    });
    const recoveryPolicy = monitorRecoveryPolicy(monitor);
    const monitorMetadata = {
      serviceName: monitor?.serviceName ?? null,
      timeoutAt: monitor?.timeoutAt ?? null,
      maxAttempts: monitor?.maxAttempts ?? null,
      recoveryPolicy: monitor?.recoveryPolicy ?? null,
    };
    const executionState =
      claimed.status === "in_review"
        ? parseIssueExecutionState(claimed.executionState)
        : null;
    const currentParticipant =
      executionState?.status === "pending"
        ? executionState.currentParticipant
        : null;
    const reviewParticipantAgentId =
      currentParticipant?.type === "agent" ? currentParticipant.agentId : null;
    const isProviderQuotaReviewMonitor =
      monitor?.serviceName === PROVIDER_QUOTA_MONITOR_SERVICE_NAME &&
      Boolean(reviewParticipantAgentId);
    const targetAgentId = isProviderQuotaReviewMonitor
      ? reviewParticipantAgentId
      : claimed.assigneeAgentId;
    if (!targetAgentId) {
      throw conflict("Issue monitor has no agent target");
    }
    const wakeReason = isProviderQuotaReviewMonitor
      ? EXECUTION_REVIEW_PARTICIPANT_RECOVERY_WAKE_REASON
      : input.wakeReason;
    const reviewRecoveryContext = isProviderQuotaReviewMonitor
      ? {
          retryReason: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON,
          currentStageId: executionState?.currentStageId ?? null,
          currentStageType: executionState?.currentStageType ?? null,
          reviewRecoveryInstruction:
            "The previous reviewer run reached provider quota. Resume this execution-review stage now that the quota wait has elapsed.",
        }
      : {};

    if (clearReason) {
      return clearIssueMonitorAndRecover({
        claimed,
        policy,
        scheduledAtIso,
        nextAttemptCount,
        clearReason,
        recoveryPolicy,
        monitor,
        now: input.now,
        actorType: input.actorType,
        actorId: input.actorId,
        agentId: input.agentId,
        runId: input.runId,
        activitySource: input.activitySource,
      });
    }

    try {
      if (monitor?.serviceName === PROVIDER_QUOTA_MONITOR_SERVICE_NAME) {
        // Normalized monitor projections redact externalRef. Read the claimed
        // persisted policy only on this server-owned quota recovery path.
        const sourceRunId = readNonEmptyString(
          parseObject(parseObject(claimed.executionPolicy).monitor).externalRef,
        );
        const sourceRun =
          sourceRunId && isUuidLike(sourceRunId)
            ? await getRun(sourceRunId, { unsafeFullResultJson: true })
            : null;
        if (
          !sourceRun ||
          sourceRun.companyId !== claimed.companyId ||
          sourceRun.agentId !== targetAgentId ||
          sourceRun.contextSnapshot?.issueId !== claimed.id ||
          !["failed", "timed_out", "interrupted", "cancelled"].includes(
            sourceRun.status,
          )
        ) {
          throw conflict(
            "The quota recovery source changed; inspect the current task execution.",
          );
        }
        if (sourceRun.runtimeMode === "native") {
          throw conflict(
            "Native execution recovery owns this provider failure; a quota monitor cannot start a replacement.",
          );
        }
        if (await legacyExecutionNeedsReconciliationWithEvidence(db, sourceRun)) {
          await terminalizeLegacyExecution({
            db,
            run: sourceRun,
            status: sourceRun.status,
          });
        } else {
          const targetAgent = await getAgent(targetAgentId);
          if (!targetAgent)
            throw conflict("The quota recovery agent is unavailable.");
          const scheduled = await scheduleBoundedRetryForRun(
            sourceRun,
            targetAgent,
            {
              now: input.now,
              ...(isProviderQuotaReviewMonitor
                ? {
                    retryReason:
                      EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON,
                    wakeReason:
                      EXECUTION_REVIEW_PARTICIPANT_RECOVERY_WAKE_REASON,
                  }
                : {}),
            },
          );
          if (scheduled.outcome === "not_scheduled")
            throw conflict(scheduled.reason);
        }
      } else {
        const wake = await enqueueWakeup(targetAgentId, {
          issueStateGuard: { statuses: [claimed.status], assigneeAgentId: claimed.assigneeAgentId,
            monitorNextCheckAt: scheduledAtIso, monitorWakeRequestedAt: claimed.monitorWakeRequestedAt!.toISOString() },
          source: input.source,
          triggerDetail: input.triggerDetail,
          reason: wakeReason,
          idempotencyKey: `issue-monitor:${claimed.id}:${scheduledAtIso}`,
          payload: {
            issueId: claimed.id,
            nextCheckAt: scheduledAtIso,
            monitorAttemptCount: nextAttemptCount,
            monitorNotes: claimed.monitorNotes ?? null,
            ...monitorMetadata,
            ...reviewRecoveryContext,
            source: input.activitySource,
          },
          requestedByActorType: input.actorType,
          requestedByActorId: input.actorId,
          contextSnapshot: {
            issueId: claimed.id,
            source: isProviderQuotaReviewMonitor
              ? "issue.execution_review_recovery"
              : "issue.monitor",
            wakeReason,
            nextCheckAt: scheduledAtIso,
            monitorAttemptCount: nextAttemptCount,
            monitorNotes: claimed.monitorNotes ?? null,
            ...monitorMetadata,
            ...reviewRecoveryContext,
            manualTrigger: input.activitySource === "manual",
          },
        });
        if (!wake) {
          await db.update(issues).set({ monitorWakeRequestedAt: null, updatedAt: input.now })
            .where(issueMonitorClaimCondition(claimed));
          return { outcome: "skipped" as const, reason: "monitor_dispatch_deferred" };
        }
      }

      const consumed = await db
        .update(issues)
        .set({
          ...monitorOnlyDispatchPatch(buildIssueMonitorTriggeredPatch({
            issue: claimed,
            policy,
            triggeredAt: input.now,
          })),
          updatedAt: new Date(),
        })
        .where(issueMonitorClaimCondition(claimed))
        .returning({ id: issues.id });
      if (consumed.length === 0) return { outcome: "skipped" as const, reason: "monitor_replaced" };

      await logActivity(db, {
        companyId: claimed.companyId,
        actorType: input.actorType,
        actorId: input.actorId,
        agentId: input.agentId,
        runId: input.runId,
        action: "issue.monitor_triggered",
        entityType: "issue",
        entityId: claimed.id,
        details: {
          identifier: claimed.identifier,
          nextCheckAt: scheduledAtIso,
          lastTriggeredAt: input.now.toISOString(),
          attemptCount: nextAttemptCount,
          notes: claimed.monitorNotes ?? null,
          ...monitorMetadata,
          source: input.activitySource,
        },
      });

      return { outcome: "triggered" as const };
    } catch (err) {
      if (err instanceof HttpError && err.status >= 400 && err.status < 500) {
        if (input.clearOnClientError) {
          await db
            .update(issues)
            .set({
              ...monitorOnlyDispatchPatch(buildIssueMonitorClearedPatch({
                issue: claimed,
                policy,
                clearReason: "dispatch_skipped",
                clearedAt: input.now,
              })),
              updatedAt: new Date(),
            })
            .where(issueMonitorClaimCondition(claimed));

          await logActivity(db, {
            companyId: claimed.companyId,
            actorType: input.actorType,
            actorId: input.actorId,
            agentId: input.agentId,
            runId: input.runId,
            action: "issue.monitor_skipped",
            entityType: "issue",
            entityId: claimed.id,
            details: {
              identifier: claimed.identifier,
              nextCheckAt: scheduledAtIso,
              attemptCount: nextAttemptCount,
              notes: claimed.monitorNotes ?? null,
              reason: err.message,
              source: input.activitySource,
            },
          });

          return { outcome: "skipped" as const, reason: err.message };
        }

        await db
          .update(issues)
          .set({
            monitorWakeRequestedAt: null,
            updatedAt: new Date(),
          })
          .where(issueMonitorClaimCondition(claimed));
      } else {
        await db
          .update(issues)
          .set({
            monitorWakeRequestedAt: null,
            updatedAt: new Date(),
          })
          .where(issueMonitorClaimCondition(claimed));
      }

      throw err;
    }
  }

  function noActiveNativeMonitorRun() {
    return sql`not exists (select 1 from ${heartbeatRuns} monitor_run
      where monitor_run.company_id = ${issues.companyId}
        and monitor_run.native_issue_id = ${issues.id}
        and monitor_run.runtime_mode = 'native'
        and monitor_run.status in ('queued', 'running', 'scheduled_retry'))`;
  }

  async function triggerIssueMonitor(
    issueId: string,
    input?: {
      now?: Date;
      actorType?: "user" | "agent" | "system";
      actorId?: string | null;
      agentId?: string | null;
      runId?: string | null;
      wakeReason?: string;
    },
  ) {
    const now = input?.now ?? new Date();
    const actorType = input?.actorType ?? "system";
    const actorId =
      input?.actorId ?? (actorType === "system" ? "heartbeat_scheduler" : null);
    if (!actorId) {
      throw conflict("Issue monitor trigger requires an actor");
    }

    const issue = await db
      .select(issueMonitorDispatchColumns)
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!issue) {
      throw notFound("Issue not found");
    }
    if (!issue.monitorNextCheckAt) {
      throw conflict("Issue has no scheduled monitor");
    }
    if (!issue.assigneeAgentId || issue.assigneeUserId) {
      throw conflict("Issue monitor requires an agent assignee");
    }
    if (!["in_progress", "in_review"].includes(issue.status)) {
      throw conflict(
        "Issue monitor can only run while the issue is in progress or in review",
      );
    }

    const staleClaimThreshold = new Date(now.getTime() - 5 * 60 * 1000);
    const claimed = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(issues)
        .set({
          monitorWakeRequestedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(issues.id, issueId),
            sql`${issues.monitorNextCheckAt} is not null`,
            isNull(issues.assigneeUserId),
            sql`${issues.assigneeAgentId} is not null`,
            inArray(issues.status, ["in_progress", "in_review"]),
            or(
              isNull(issues.monitorWakeRequestedAt),
              lt(issues.monitorWakeRequestedAt, staleClaimThreshold),
            ),
          ),
        )
        .returning();
      return (updated ?? null) as IssueMonitorDispatchRow | null;
    });

    if (!claimed) {
      throw conflict("Issue monitor check is already in progress");
    }

    return dispatchClaimedIssueMonitor(claimed, {
      now,
      source: "on_demand",
      triggerDetail: "manual",
      wakeReason: input?.wakeReason ?? "issue_monitor_due",
      actorType,
      actorId,
      agentId: input?.agentId ?? null,
      runId: input?.runId ?? null,
      clearOnClientError: false,
      activitySource: "manual",
    });
  }

  async function tickDueIssueMonitors(now = new Date()) {
    const staleClaimThreshold = new Date(now.getTime() - 5 * 60 * 1000);
    const dueMonitors = await db
      .select(issueMonitorDispatchColumns)
      .from(issues)
      .innerJoin(companies, eq(companies.id, issues.companyId))
      .where(
        and(
          eq(companies.status, "active"),
          noActiveNativeMonitorRun(),
          sql`${issues.monitorNextCheckAt} is not null`,
          lte(issues.monitorNextCheckAt, now),
          isNull(issues.assigneeUserId),
          sql`${issues.assigneeAgentId} is not null`,
          inArray(issues.status, ["in_progress", "in_review"]),
          or(
            isNull(issues.monitorWakeRequestedAt),
            lt(issues.monitorWakeRequestedAt, staleClaimThreshold),
          ),
        ),
      )
      .orderBy(asc(issues.monitorNextCheckAt), asc(issues.updatedAt))
      .limit(50);

    let triggered = 0;
    let skipped = 0;

    for (const due of dueMonitors) {
      const claimed = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(issues)
          .set({
            monitorWakeRequestedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(issues.id, due.id),
              noActiveNativeMonitorRun(),
              sql`${issues.monitorNextCheckAt} is not null`,
              lte(issues.monitorNextCheckAt, now),
              isNull(issues.assigneeUserId),
              sql`${issues.assigneeAgentId} is not null`,
              inArray(issues.status, ["in_progress", "in_review"]),
              or(
                isNull(issues.monitorWakeRequestedAt),
                lt(issues.monitorWakeRequestedAt, staleClaimThreshold),
              ),
            ),
          )
          .returning();
        return (updated ?? null) as IssueMonitorDispatchRow | null;
      });

      if (!claimed) continue;

      try {
        const result = await dispatchClaimedIssueMonitor(claimed, {
          now,
          source: "automation",
          triggerDetail: "system",
          wakeReason: "issue_monitor_due",
          actorType: "system",
          actorId: "heartbeat_scheduler",
          agentId: null,
          runId: null,
          clearOnClientError: true,
          activitySource: "scheduled",
        });
        if (result.outcome === "triggered") triggered += 1;
        if (result.outcome === "skipped") skipped += 1;
      } catch (err) {
        logger.error({ err, issueId: claimed.id }, "issue monitor tick failed");
      }
    }

    return {
      checked: dueMonitors.length,
      triggered,
      skipped,
    };
  }

  async function recoverActiveSessionGoals() {
    if ((await getSchedulingSuppression()).suppressed) {
      return { scanned: 0, enqueued: 0 };
    }
    const sessions = await db
      .select({
        id: agentTaskSessions.id,
        companyId: agentTaskSessions.companyId,
        agentId: agentTaskSessions.agentId,
        issueId: agentTaskSessions.taskKey,
        revision: agentTaskSessions.goalRevision,
      })
      .from(agentTaskSessions)
      .innerJoin(
        issues,
        and(
          sql`${issues.id}::text = ${agentTaskSessions.taskKey}`,
          eq(issues.companyId, agentTaskSessions.companyId),
          eq(issues.assigneeAgentId, agentTaskSessions.agentId),
        ),
      )
      .where(
        and(
          eq(agentTaskSessions.goalDesiredState, "active"),
          eq(agentTaskSessions.goalStatus, "active"),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    let enqueued = 0;
    for (const session of sessions) {
      const run = await enqueueWakeup(session.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "goal_control",
        payload: { issueId: session.issueId, intent: "goal_recovery" },
        idempotencyKey: `goal_recovery:${session.id}:${session.revision}`,
        requestedByActorType: "system",
        contextSnapshot: {
          issueId: session.issueId,
          taskKey: session.issueId,
          resumeSessionGoalHeartbeat: true,
          skipIssueComment: true,
        },
      });
      if (run) enqueued += 1;
    }
    return { scanned: sessions.length, enqueued };
  }

  async function recoverPendingSessionGoalActions() {
    if ((await getSchedulingSuppression()).suppressed) {
      return { scanned: 0, enqueued: 0, alreadyQueued: 0, invalid: 0 };
    }
    const pending = await db
      .select({
        id: agentSessionGoalActions.id,
        requestId: agentSessionGoalActions.requestId,
        payload: agentSessionGoalActions.payloadJson,
        companyId: agentTaskSessions.companyId,
        agentId: agentTaskSessions.agentId,
        adapterType: agentTaskSessions.adapterType,
        issueId: agentTaskSessions.taskKey,
      })
      .from(agentSessionGoalActions)
      .innerJoin(
        agentTaskSessions,
        eq(agentTaskSessions.id, agentSessionGoalActions.sessionId),
      )
      .innerJoin(
        issues,
        and(
          sql`${issues.id}::text = ${agentTaskSessions.taskKey}`,
          eq(issues.companyId, agentTaskSessions.companyId),
          eq(issues.assigneeAgentId, agentTaskSessions.agentId),
        ),
      )
      .where(
        inArray(agentSessionGoalActions.status, [
          "pending",
          "delivering",
          "delivered",
        ]),
      )
      .orderBy(asc(agentSessionGoalActions.createdAt));

    let enqueued = 0;
    let alreadyQueued = 0;
    let invalid = 0;
    for (const action of pending) {
      const control = parseNativeSessionGoalControl(action.payload);
      if (!control || control.requestId !== action.requestId) {
        invalid += 1;
        await failRunnerGoalAction(
          db,
          {
            companyId: action.companyId,
            issueId: action.issueId,
            agentId: action.agentId,
            adapterType: action.adapterType,
          },
          action.requestId,
          "session_goal_control_payload_invalid",
        ).catch(() => undefined);
        continue;
      }

      const inFlight = await db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, action.companyId),
            eq(heartbeatRuns.agentId, action.agentId),
            inArray(heartbeatRuns.status, [
              "queued",
              "scheduled_retry",
              "running",
            ]),
          ),
        )
        .then((runs) =>
          runs.some(
            (run) =>
              readNonEmptyString(
                parseObject(run.contextSnapshot).goalControlRequestId,
              ) === action.requestId,
          ),
        );
      if (inFlight) {
        alreadyQueued += 1;
        continue;
      }

      const run = await enqueueWakeup(action.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "goal_control",
        payload: {
          issueId: action.issueId,
          requestId: action.requestId,
          intent: "goal_control_recovery",
        },
        idempotencyKey: `goal_control_recovery:${action.id}`,
        requestedByActorType: "system",
        contextSnapshot: {
          issueId: action.issueId,
          taskKey: action.issueId,
          // Goal controls reconcile the provider session itself and remain
          // valid after issue terminalization (for example, clearing a
          // completed goal from its retained widget).
          resumeIntent: true,
          goalControlRequestId: action.requestId,
          runnerGoalControl: control,
          skipIssueComment: true,
        },
      });
      if (run) enqueued += 1;
    }
    return { scanned: pending.length, enqueued, alreadyQueued, invalid };
  }

  async function tickCriticalExecutionSla(
    now: Date,
    agentById: Map<string, typeof agents.$inferSelect>,
  ) {
    const warningCutoff = new Date(now.getTime() - 30 * 60 * 1000);
    const breachCutoff = new Date(now.getTime() - 45 * 60 * 1000);
    const retryCutoff = new Date(now.getTime() - 5 * 60 * 1000);
    const firstIdentifiedAtExpr = sql<Date>`coalesce(${issues.executionSlaFirstIdentifiedAt}, ${issues.blockedTransitionAt})`.mapWith(issues.executionSlaFirstIdentifiedAt);
    // Raw COALESCE expressions have no column encoder, so bind timestamps as
    // ISO text with an explicit PostgreSQL cast instead of passing Date bytes.
    const warningCutoffExpr = sql<Date>`${warningCutoff.toISOString()}::timestamptz`;
    const breachCutoffExpr = sql<Date>`${breachCutoff.toISOString()}::timestamptz`;
    const dueIssues = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        projectId: issues.projectId,
        projectWorkspaceId: issues.projectWorkspaceId,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        firstIdentifiedAt: firstIdentifiedAtExpr,
        blockedTransitionAt: issues.blockedTransitionAt,
        executionSlaWarningAttemptAt: issues.executionSlaWarningAttemptAt,
        executionSlaBreachAttemptAt: issues.executionSlaBreachAttemptAt,
        executionSlaWarningAt: issues.executionSlaWarningAt,
        executionSlaBreachAt: issues.executionSlaBreachAt,
      })
      .from(issues)
      .innerJoin(companies, eq(companies.id, issues.companyId))
      .where(and(
        eq(companies.status, "active"),
        eq(companies.executionSlaEnabled, true),
        isNull(issues.hiddenAt),
        inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
        lte(firstIdentifiedAtExpr, warningCutoffExpr),
        or(
          and(
            isNull(issues.executionSlaBreachAt),
            lte(firstIdentifiedAtExpr, breachCutoffExpr),
            or(isNull(issues.executionSlaBreachAttemptAt), lte(issues.executionSlaBreachAttemptAt, retryCutoff)),
          ),
          and(
            isNull(issues.executionSlaBreachAt),
            gt(firstIdentifiedAtExpr, breachCutoffExpr),
            isNull(issues.executionSlaWarningAt),
            or(isNull(issues.executionSlaWarningAttemptAt), lte(issues.executionSlaWarningAttemptAt, retryCutoff)),
          ),
        ),
      ))
      .orderBy(asc(issues.createdAt), asc(issues.id))
      .limit(100);

    // Active runs fence assignment transfer, but never suppress deadline
    // escalation. Pending wakes coalesce only duplicate notifications for the
    // same stage; warning cannot block breach escalation.
    const dueIssueIds = dueIssues.map((issue) => issue.id);
    const activeIssueIds = new Set<string>();
    const pendingWarningIssueIds = new Set<string>();
    const pendingBreachIssueIds = new Set<string>();
    const pendingTakeoverIssueIds = new Set<string>();
    if (dueIssueIds.length > 0) {
      const activeRuns = await db
        .select({ nativeIssueId: heartbeatRuns.nativeIssueId, issueId: heartbeatRuns.issueId })
        .from(heartbeatRuns)
        .where(and(
          inArray(heartbeatRuns.companyId, [...new Set(dueIssues.map((issue) => issue.companyId))]),
          inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
          or(
            inArray(heartbeatRuns.nativeIssueId, dueIssueIds),
            inArray(heartbeatRuns.issueId, dueIssueIds),
          ),
        ));
      for (const run of activeRuns) {
        if (run.nativeIssueId) activeIssueIds.add(run.nativeIssueId);
        if (run.issueId) activeIssueIds.add(run.issueId);
      }
      const pendingWakes = await db
        .select({ payload: agentWakeupRequests.payload, reason: agentWakeupRequests.reason })
        .from(agentWakeupRequests)
        .where(and(
          inArray(agentWakeupRequests.companyId, [...new Set(dueIssues.map((issue) => issue.companyId))]),
          inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
          inArray(agentWakeupRequests.reason, ["critical_execution_sla_warning", "critical_execution_sla_breach", "issue_assigned"]),
          gte(agentWakeupRequests.requestedAt, retryCutoff),
        ));
      for (const request of pendingWakes) {
        const payload = parseObject(request.payload);
        const issueIds = Array.isArray(payload.issueIds)
          ? payload.issueIds.filter((id): id is string => typeof id === "string")
          : [];
        const singleIssueId = readNonEmptyString(payload.issueId ?? payload.taskId);
        for (const issueId of [...issueIds, ...(singleIssueId ? [singleIssueId] : [])]) {
          if (request.reason === "critical_execution_sla_warning") pendingWarningIssueIds.add(issueId);
          else if (request.reason === "critical_execution_sla_breach") pendingBreachIssueIds.add(issueId);
          else if (request.reason === "issue_assigned") pendingTakeoverIssueIds.add(issueId);
        }
      }
    }

    async function matchingCurrentOperation(
      issue: (typeof dueIssues)[number],
      candidate: typeof agents.$inferSelect,
      readDb: Db = db,
    ) {
      if (!issue.projectId || !issue.projectWorkspaceId || !issue.assigneeAgentId) return null;
      const [registeredWorkspace] = await readDb.select({ id: projectWorkspaces.id }).from(projectWorkspaces).where(and(
        eq(projectWorkspaces.id, issue.projectWorkspaceId),
        eq(projectWorkspaces.companyId, issue.companyId),
        eq(projectWorkspaces.projectId, issue.projectId),
      )).limit(1);
      if (!registeredWorkspace) return null;
      // Capability evidence must identify the same concrete connection as the
      // latest failed source operation, so gather the source failures first.
      const sourceEvents = await readDb
        .select({
          id: toolCallEvents.id,
          companyId: toolCallEvents.companyId,
          issueId: toolCallEvents.issueId,
          agentId: toolCallEvents.agentId,
          connectionId: toolCallEvents.connectionId,
          toolName: toolCallEvents.toolName,
          requestHash: toolCallEvents.requestHash,
          outcome: toolCallEvents.outcome,
          eventType: toolCallEvents.eventType,
          createdAt: toolCallEvents.createdAt,
          projectWorkspaceId: issues.projectWorkspaceId,
        })
        .from(toolCallEvents)
        .innerJoin(issues, and(eq(issues.id, toolCallEvents.issueId), eq(issues.companyId, toolCallEvents.companyId)))
        .where(and(
          eq(toolCallEvents.companyId, issue.companyId),
          eq(toolCallEvents.issueId, issue.id),
          eq(toolCallEvents.agentId, issue.assigneeAgentId),
          eq(issues.projectWorkspaceId, issue.projectWorkspaceId),
          eq(issues.projectId, issue.projectId),
          gte(toolCallEvents.createdAt, issue.blockedTransitionAt ?? issue.firstIdentifiedAt),
          lte(toolCallEvents.createdAt, now),
          inArray(toolCallEvents.eventType, ["call_failed", "call_denied"]),
        ))
        .orderBy(desc(toolCallEvents.createdAt))
        .limit(10);
      const latestSource = sourceEvents[0];
      if (!latestSource?.connectionId || !latestSource.toolName || !latestSource.requestHash) return null;
      const connection = await readDb
        .select({ id: toolConnections.id, credentialPolicy: toolConnections.credentialPolicy })
        .from(toolConnections)
        .where(and(
          eq(toolConnections.id, latestSource.connectionId),
          eq(toolConnections.companyId, issue.companyId),
          eq(toolConnections.enabled, true),
          eq(toolConnections.status, "active"),
        ))
        .then((rows) => rows[0] ?? null);
      if (!connection) return null;

      const effective = await toolAccessService(readDb).getEffectiveProfilesForAgent(issue.companyId, candidate.id);
      const installed = effective.installedConnections.some((item) =>
        item.id === connection.id && item.enabled && item.status === "active",
      );
      const allowed = effective.allowedTools.some((item) =>
        item.connectionId === connection.id && item.toolName === latestSource.toolName,
      );
      if (!installed || !allowed) return null;
      if (connection.credentialPolicy !== "shared" && connection.credentialPolicy !== "per_agent") return null;
      const grantScope = connection.credentialPolicy === "shared"
        ? and(eq(connectionGrants.kind, "organization"), isNull(connectionGrants.subjectAgentId))
        : and(eq(connectionGrants.kind, "agent"), eq(connectionGrants.subjectAgentId, candidate.id));
      const grant = await readDb.select({ id: connectionGrants.id }).from(connectionGrants).where(and(
        eq(connectionGrants.companyId, issue.companyId),
        eq(connectionGrants.connectionId, connection.id),
        grantScope,
        eq(connectionGrants.status, "active"),
        isNull(connectionGrants.revokedAt),
      )).limit(1);
      if (grant.length === 0) return null;

      const candidateEvents = await readDb
        .select({
          id: toolCallEvents.id,
          companyId: toolCallEvents.companyId,
          issueId: toolCallEvents.issueId,
          agentId: toolCallEvents.agentId,
          connectionId: toolCallEvents.connectionId,
          toolName: toolCallEvents.toolName,
          requestHash: toolCallEvents.requestHash,
          outcome: toolCallEvents.outcome,
          eventType: toolCallEvents.eventType,
          createdAt: toolCallEvents.createdAt,
          projectWorkspaceId: issues.projectWorkspaceId,
        })
        .from(toolCallEvents)
        .innerJoin(issues, and(eq(issues.id, toolCallEvents.issueId), eq(issues.companyId, toolCallEvents.companyId)))
        .where(and(
          eq(toolCallEvents.companyId, issue.companyId),
          eq(toolCallEvents.agentId, candidate.id),
          eq(toolCallEvents.connectionId, connection.id),
          eq(toolCallEvents.toolName, latestSource.toolName),
          eq(toolCallEvents.requestHash, latestSource.requestHash),
          eq(toolCallEvents.eventType, "call_completed"),
          eq(toolCallEvents.outcome, "success"),
          eq(issues.projectWorkspaceId, issue.projectWorkspaceId),
          eq(issues.projectId, issue.projectId),
          gte(toolCallEvents.createdAt, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)),
          lte(toolCallEvents.createdAt, now),
        ))
        .orderBy(desc(toolCallEvents.createdAt))
        .limit(10);
      const match = matchingExecutionSlaCapabilityReceipt({
        companyId: issue.companyId,
        sourceIssueId: issue.id,
        sourceOwnerAgentId: issue.assigneeAgentId,
        candidateAgentId: candidate.id,
        projectWorkspaceId: issue.projectWorkspaceId,
        blockedSince: issue.blockedTransitionAt ?? issue.firstIdentifiedAt,
        now,
        maxAgeMs: 30 * 24 * 60 * 60 * 1000,
        sourceEvents,
        candidateEvents,
      });
      return match ? { ...match, connectionId: connection.id, toolName: latestSource.toolName } : null;
    }

    const retriedTakeoverIssueIds = new Set<string>();
    let enqueued = 0;
    const pendingTakeovers = await db.select({
      id: issueRecoveryActions.id,
      companyId: issueRecoveryActions.companyId,
      sourceIssueId: issueRecoveryActions.sourceIssueId,
      ownerAgentId: issueRecoveryActions.ownerAgentId,
      returnOwnerAgentId: issueRecoveryActions.returnOwnerAgentId,
      evidence: issueRecoveryActions.evidence,
      lastAttemptAt: issueRecoveryActions.lastAttemptAt,
      issueStatus: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      firstIdentifiedAt: firstIdentifiedAtExpr,
    }).from(issueRecoveryActions)
      .innerJoin(issues, and(eq(issues.id, issueRecoveryActions.sourceIssueId), eq(issues.companyId, issueRecoveryActions.companyId)))
      .innerJoin(companies, eq(companies.id, issues.companyId))
      .where(and(
        eq(issueRecoveryActions.kind, "execution_sla_takeover"),
        inArray(issueRecoveryActions.status, ["active", "escalated"]),
        eq(companies.status, "active"),
        eq(companies.executionSlaEnabled, true),
        inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
      ))
      .orderBy(asc(issueRecoveryActions.updatedAt))
      .limit(100);

    // A takeover is not discharged by inserting a recovery row or changing the
    // owner. Retry an unaccepted owner wake on the existing timer path, with a
    // durable five-minute attempt boundary and the same source/deadline receipt.
    for (const pending of pendingTakeovers) {
      const ownerId = pending.ownerAgentId;
      const dispatch = parseObject(pending.evidence.executionSlaDispatch);
      let dispatchStatus = readNonEmptyString(dispatch.status);
      if (dispatchStatus === "queued" && typeof dispatch.wakeRequestId === "string") {
        const [previousWake] = await db.select({
          status: agentWakeupRequests.status,
          requestedAt: agentWakeupRequests.requestedAt,
          claimedAt: agentWakeupRequests.claimedAt,
        }).from(agentWakeupRequests)
          .where(and(eq(agentWakeupRequests.id, dispatch.wakeRequestId), eq(agentWakeupRequests.companyId, pending.companyId)))
          .limit(1);
        if (!previousWake || ["failed", "cancelled", "skipped"].includes(previousWake.status)) {
          dispatchStatus = "pending";
        } else {
          const wakeAgeFrom = previousWake.claimedAt ?? previousWake.requestedAt;
          if (wakeAgeFrom.getTime() <= retryCutoff.getTime() && !activeIssueIds.has(pending.sourceIssueId)) {
            dispatchStatus = "pending";
          }
        }
      }
      const lastAttemptAt = pending.lastAttemptAt
        ?? (typeof dispatch.lastAttemptAt === "string" ? new Date(dispatch.lastAttemptAt) : null);
      if (!ownerId || dispatchStatus === "queued" || activeIssueIds.has(pending.sourceIssueId) || pendingTakeoverIssueIds.has(pending.sourceIssueId) ||
        (lastAttemptAt && lastAttemptAt.getTime() > retryCutoff.getTime())) continue;
      const owner = agentById.get(ownerId);
      if (!owner || owner.companyId !== pending.companyId ||
        !evaluateAgentInvokability(toAgentOrgRow(owner), [...agentById.values()].filter((agent) => agent.companyId === pending.companyId).map(toAgentOrgRow)).invokable) continue;

      const claimed = await db.transaction(async (tx) => {
        const [action] = await tx.select({
          id: issueRecoveryActions.id,
          evidence: issueRecoveryActions.evidence,
          lastAttemptAt: issueRecoveryActions.lastAttemptAt,
        }).from(issueRecoveryActions).where(and(
          eq(issueRecoveryActions.id, pending.id),
          eq(issueRecoveryActions.companyId, pending.companyId),
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
        )).for("update");
        if (!action) return null;
        const currentDispatch = parseObject(action.evidence.executionSlaDispatch);
        const currentStatus = readNonEmptyString(currentDispatch.status);
        if (currentStatus === "queued" && typeof currentDispatch.wakeRequestId === "string") {
          const [previousWake] = await tx.select({
            id: agentWakeupRequests.id,
            status: agentWakeupRequests.status,
            requestedAt: agentWakeupRequests.requestedAt,
            claimedAt: agentWakeupRequests.claimedAt,
          }).from(agentWakeupRequests)
            .where(and(eq(agentWakeupRequests.id, currentDispatch.wakeRequestId), eq(agentWakeupRequests.companyId, pending.companyId)))
            .for("update")
            .limit(1);
          if (previousWake && !["failed", "cancelled", "skipped"].includes(previousWake.status)) {
            const wakeAgeFrom = previousWake.claimedAt ?? previousWake.requestedAt;
            if (wakeAgeFrom.getTime() > retryCutoff.getTime()) return null;
            const [activeRun] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
              eq(heartbeatRuns.companyId, pending.companyId),
              inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
              or(eq(heartbeatRuns.nativeIssueId, pending.sourceIssueId), eq(heartbeatRuns.issueId, pending.sourceIssueId)),
            )).limit(1);
            const [activeOperation] = await tx.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
              eq(workspaceOperations.companyId, pending.companyId),
              eq(workspaceOperations.issueId, pending.sourceIssueId),
              eq(workspaceOperations.status, "running"),
            )).limit(1);
            if (activeRun || activeOperation) return null;
            await tx.update(agentWakeupRequests).set({
              status: "failed",
              error: "Execution SLA takeover wake exceeded its bounded queue age without an active issue run.",
              finishedAt: now,
              updatedAt: now,
            }).where(and(
              eq(agentWakeupRequests.id, previousWake.id),
              eq(agentWakeupRequests.companyId, pending.companyId),
              inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
            ));
          }
        } else if (currentStatus === "queued") {
          return null;
        }
        if (action.lastAttemptAt && action.lastAttemptAt.getTime() > retryCutoff.getTime()) return null;
        const [currentIssue] = await tx.select({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          executionSlaFirstIdentifiedAt: issues.executionSlaFirstIdentifiedAt,
          blockedTransitionAt: issues.blockedTransitionAt,
        }).from(issues).where(and(
          eq(issues.id, pending.sourceIssueId),
          eq(issues.companyId, pending.companyId),
          eq(issues.assigneeAgentId, ownerId),
          inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
          await issueReadSqlCondition(tx, { type: "agent", agentId: ownerId, companyId: pending.companyId }),
        )).for("update");
        if (!currentIssue || (currentIssue.executionSlaFirstIdentifiedAt ?? currentIssue.blockedTransitionAt)?.getTime() !== pending.firstIdentifiedAt.getTime()) return null;
        const attemptCount = typeof currentDispatch.attemptCount === "number" ? currentDispatch.attemptCount : 0;
        await tx.update(issueRecoveryActions).set({
          evidence: {
            ...action.evidence,
            executionSlaDispatch: {
              ...currentDispatch,
              status: "dispatching",
              attemptCount: attemptCount + 1,
              lastAttemptAt: now.toISOString(),
            },
          },
          attemptCount: sql`${issueRecoveryActions.attemptCount} + 1`,
          lastAttemptAt: now,
          updatedAt: now,
        }).where(eq(issueRecoveryActions.id, action.id));
        return { id: action.id, stage: readNonEmptyString(action.evidence.stage) ?? "breach" };
      });
      if (!claimed) continue;

      const window = Math.floor(now.getTime() / (5 * 60 * 1000));
      const idempotencyKey = `execution-sla-takeover:${claimed.id}:${window}`;
      let wakeError: string | null = null;
      try {
        await enqueueWakeup(ownerId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          idempotencyKey,
          requestedByActorType: "system",
          requestedByActorId: "heartbeat_scheduler",
          payload: { issueId: pending.sourceIssueId, taskId: pending.sourceIssueId, source: "execution_sla_takeover" },
          contextSnapshot: {
            source: "execution_sla_takeover",
            issueId: pending.sourceIssueId,
            taskId: pending.sourceIssueId,
            executionSlaTakeover: {
              actionId: claimed.id,
              stage: claimed.stage,
              firstIdentifiedAt: pending.firstIdentifiedAt.toISOString(),
              originalOwnerAgentId: pending.returnOwnerAgentId,
              returnOwnerAgentId: pending.returnOwnerAgentId,
              operationEvidenceScope: "exact tool operation only; source objective and production acceptance remain open",
            },
          },
          issueStateGuard: { statuses: ["backlog", "todo", "in_progress", "in_review", "blocked"], assigneeAgentId: ownerId },
        });
      } catch (error) {
        wakeError = error instanceof Error ? error.message : String(error);
      }
      const wake = await db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status }).from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.companyId, pending.companyId), eq(agentWakeupRequests.idempotencyKey, idempotencyKey)))
        .limit(1).then((rows) => rows[0] ?? null);
      const accepted = Boolean(wake && !["failed", "cancelled", "skipped"].includes(wake.status));
      await db.update(issueRecoveryActions).set({
        evidence: {
          ...pending.evidence,
          executionSlaDispatch: {
            ...dispatch,
            status: accepted ? "queued" : "pending",
            attemptCount: (typeof dispatch.attemptCount === "number" ? dispatch.attemptCount : 0) + 1,
            lastAttemptAt: now.toISOString(),
            wakeRequestId: wake?.id ?? null,
            wakeStatus: wake?.status ?? null,
            lastError: wakeError,
          },
        },
        updatedAt: now,
      }).where(and(
        eq(issueRecoveryActions.id, pending.id),
        eq(issueRecoveryActions.companyId, pending.companyId),
        inArray(issueRecoveryActions.status, ["active", "escalated"]),
      ));
      retriedTakeoverIssueIds.add(pending.sourceIssueId);
      if (accepted) enqueued += 1;
    }

    let skipped = 0;
    const batches = new Map<string, {
      companyId: string;
      manager: typeof agents.$inferSelect;
      stage: "warning" | "breach";
      attemptColumn: "warning" | "breach";
      issues: typeof dueIssues;
    }>();
    for (const issue of dueIssues) {
      const owner = issue.assigneeAgentId ? agentById.get(issue.assigneeAgentId) : null;
      const directManagerId = owner?.reportsTo ?? null;
      const stageKey = executionSlaStage({
        firstIdentifiedAt: issue.firstIdentifiedAt,
        now,
        warningAt: issue.executionSlaWarningAt,
        breachAt: issue.executionSlaBreachAt,
      });
      // A fresh wake for this same stage coalesces duplicate notification, but
      // another stage must still escalate independently. Active runs never
      // suppress escalation; they only fence reassignment and workspace writes.
      if ((stageKey === "warning" && pendingWarningIssueIds.has(issue.id)) ||
        (stageKey === "breach" && pendingBreachIssueIds.has(issue.id))) {
        skipped += 1;
        continue;
      }
      const attemptAt = stageKey === "breach"
        ? issue.executionSlaBreachAttemptAt
        : issue.executionSlaWarningAttemptAt;
      // Start with the accountable direct manager for both warning and breach.
      // If that seat is unavailable, the loop below follows reportsTo upward;
      // starting at the manager's manager would skip a capable direct owner.
      let stageFirstManagerId = directManagerId
        ?? [...agentById.values()].find((agent) => agent.companyId === issue.companyId && !agent.reportsTo)?.id
        ?? null;
      if (stageKey === "breach" && issue.executionSlaWarningAt && directManagerId) {
        // A warning already accepted by the first manager but not acted on by
        // the 45-minute point advances one level in the same reporting chain.
        // If no higher manager is configured, retain the direct manager as the
        // executable resolver rather than dropping the open breach.
        stageFirstManagerId = agentById.get(directManagerId)?.reportsTo ?? directManagerId;
      }
      const stages = stageKey && executionSlaRetryDue(attemptAt, now)
        ? [{ key: stageKey, attemptColumn: stageKey, firstManagerId: stageFirstManagerId }]
        : [];

      for (const stage of stages) {
        const claimAt = now;
        const claimed = await db
          .update(issues)
          .set(stage.attemptColumn === "warning"
            ? { executionSlaWarningAttemptAt: claimAt, updatedAt: now }
            : { executionSlaBreachAttemptAt: claimAt, updatedAt: now })
          .where(and(
            eq(issues.id, issue.id),
            eq(issues.companyId, issue.companyId),
            inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
            isNull(stage.attemptColumn === "warning" ? issues.executionSlaWarningAt : issues.executionSlaBreachAt),
            or(
              isNull(stage.attemptColumn === "warning" ? issues.executionSlaWarningAttemptAt : issues.executionSlaBreachAttemptAt),
              lte(stage.attemptColumn === "warning" ? issues.executionSlaWarningAttemptAt : issues.executionSlaBreachAttemptAt, retryCutoff),
            ),
          ))
          .returning({ id: issues.id });
        if (claimed.length === 0) continue;

        const companyAgents = agentById.size > 0
          ? [...agentById.values()].filter((agent) => agent.companyId === issue.companyId)
          : [];
        const orgRows = companyAgents.map(toAgentOrgRow);
        let candidateId = stage.firstManagerId;
        let target: typeof agents.$inferSelect | null = null;
        let fallbackTarget: typeof agents.$inferSelect | null = null;
        let operationMatch: Awaited<ReturnType<typeof matchingCurrentOperation>> = null;
        const visited = new Set<string>();
        while (candidateId && !visited.has(candidateId)) {
          visited.add(candidateId);
          const candidate = agentById.get(candidateId);
          if (!candidate || candidate.companyId !== issue.companyId) break;
          const result = evaluateAgentInvokability(toAgentOrgRow(candidate), orgRows);
          const candidateCanReadIssue = result.invokable && await db
            .select({ id: issues.id })
            .from(issues)
            .where(and(
              eq(issues.id, issue.id),
              eq(issues.companyId, issue.companyId),
              await issueReadSqlCondition(db, {
                type: "agent",
                agentId: candidate.id,
                companyId: candidate.companyId,
              }),
            ))
            .limit(1)
            .then((rows) => rows.length > 0);
          if (candidateCanReadIssue) {
            fallbackTarget ??= candidate;
            operationMatch = await matchingCurrentOperation(issue, candidate);
            if (operationMatch) {
              target = candidate;
              break;
            }
          }
          candidateId = candidate.reportsTo;
        }
        target ??= fallbackTarget;

        if (!target) {
          skipped += 1;
          await logActivity(db, {
            companyId: issue.companyId,
            actorType: "system",
            actorId: "heartbeat_scheduler",
            action: `issue.execution_sla_${stage.key}_manager_unavailable`,
            entityType: "issue",
            entityId: issue.id,
            details: {
              firstIdentifiedAt: issue.firstIdentifiedAt.toISOString(),
              deadlineAt: new Date(issue.firstIdentifiedAt.getTime() + 45 * 60 * 1000).toISOString(),
              expectedManagerAgentId: stage.firstManagerId,
              attemptedAt: now.toISOString(),
            },
          });
          continue;
        }

        // Emergency transfer is considered only after the explicit 30-minute
        // warning threshold or 45-minute breach threshold has been reached.
        // A manager wake remains useful when no exact, current operation proof
        // exists, but it is not an execution transfer or SLA completion.
        if (operationMatch && issue.assigneeAgentId && target.id !== issue.assigneeAgentId) {
          const transferred = await db.transaction(async (tx) => {
            const [current] = await tx.select({
              id: issues.id,
              companyId: issues.companyId,
              status: issues.status,
              assigneeAgentId: issues.assigneeAgentId,
              projectId: issues.projectId,
              projectWorkspaceId: issues.projectWorkspaceId,
              executionSlaFirstIdentifiedAt: issues.executionSlaFirstIdentifiedAt,
              blockedTransitionAt: issues.blockedTransitionAt,
            }).from(issues).where(and(
              eq(issues.id, issue.id),
              eq(issues.companyId, issue.companyId),
              await issueReadSqlCondition(tx, {
                type: "agent",
                agentId: target.id,
                companyId: issue.companyId,
              }),
            )).for("update");
            if (!current || current.assigneeAgentId !== issue.assigneeAgentId ||
              current.projectWorkspaceId !== issue.projectWorkspaceId ||
              current.projectId !== issue.projectId ||
              (current.executionSlaFirstIdentifiedAt ?? current.blockedTransitionAt)?.getTime() !== issue.firstIdentifiedAt.getTime() ||
              current.blockedTransitionAt?.getTime() !== issue.blockedTransitionAt?.getTime() ||
              !["backlog", "todo", "in_progress", "in_review", "blocked"].includes(current.status)) return null;

            // Revalidate the exact operation receipt and current bindings in the
            // same transaction that fences ownership transfer.
            const verifiedMatch = await matchingCurrentOperation(issue, target, tx as unknown as Db);
            if (!verifiedMatch || verifiedMatch.failed.id !== operationMatch.failed.id ||
              verifiedMatch.success.id !== operationMatch.success.id) return null;

            const [activeRun] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
              eq(heartbeatRuns.companyId, issue.companyId),
              inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
              or(eq(heartbeatRuns.nativeIssueId, issue.id), eq(heartbeatRuns.issueId, issue.id)),
            )).limit(1);
            const [activeOperation] = await tx.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
              eq(workspaceOperations.companyId, issue.companyId),
              eq(workspaceOperations.issueId, issue.id),
              eq(workspaceOperations.status, "running"),
            )).limit(1);
            const [activeRecovery] = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
              eq(issueRecoveryActions.companyId, issue.companyId),
              eq(issueRecoveryActions.sourceIssueId, issue.id),
              inArray(issueRecoveryActions.status, ["active", "escalated"]),
            )).limit(1);
            if (activeRun || activeOperation || activeRecovery) return null;

            const fingerprint = `execution-sla:${stage.key}:${issue.firstIdentifiedAt.toISOString()}:${operationMatch.failed.id}:${target.id}`;
            const updated = await issuesSvc.updateForCompany(issue.id, issue.companyId, {
              assigneeAgentId: target.id,
              assigneeUserId: null,
            }, tx);
            if (!updated) return null;
            const [action] = await tx.insert(issueRecoveryActions).values({
              companyId: issue.companyId,
              sourceIssueId: issue.id,
              kind: "execution_sla_takeover",
              status: "active",
              ownerType: "agent",
              ownerAgentId: target.id,
              previousOwnerAgentId: issue.assigneeAgentId,
              returnOwnerAgentId: issue.assigneeAgentId,
              cause: "execution_sla_operation_failure",
              fingerprint,
              evidence: {
                stage: stage.key,
                firstIdentifiedAt: issue.firstIdentifiedAt.toISOString(),
                originalOwnerAgentId: issue.assigneeAgentId,
                takeoverAgentId: target.id,
                projectWorkspaceId: issue.projectWorkspaceId,
                connectionId: verifiedMatch.connectionId,
                toolName: verifiedMatch.toolName,
                failedCallEventId: verifiedMatch.failed.id,
                matchingSuccessfulCallEventId: verifiedMatch.success.id,
                requestHash: verifiedMatch.failed.requestHash,
                executionSlaDispatch: { status: "dispatching", attemptCount: 1, lastAttemptAt: now.toISOString() },
                operationEvidenceScope: "exact tool operation only; not source objective completion or production acceptance",
              },
              nextAction: "Resume the original source issue using the verified operation capability; preserve its objective, independent acceptance, production gates, and return ownership.",
              lastAttemptAt: now,
              updatedAt: now,
            }).returning({ id: issueRecoveryActions.id, evidence: issueRecoveryActions.evidence });
            return action ? { id: action.id, evidence: action.evidence } : null;
          });
          if (transferred) {
            const idempotencyWindow = Math.floor(now.getTime() / (5 * 60 * 1000));
            const idempotencyKey = `execution-sla-takeover:${transferred.id}:${idempotencyWindow}`;
            let transferWake: Awaited<ReturnType<typeof enqueueWakeup>> | null = null;
            let transferWakeError: string | null = null;
            try {
              transferWake = await enqueueWakeup(target.id, {
                source: "assignment",
                triggerDetail: "system",
                reason: "issue_assigned",
                idempotencyKey,
                requestedByActorType: "system",
                requestedByActorId: "heartbeat_scheduler",
                payload: { issueId: issue.id, taskId: issue.id, source: "execution_sla_takeover" },
                contextSnapshot: {
                  source: "execution_sla_takeover",
                  issueId: issue.id,
                  taskId: issue.id,
                  executionSlaTakeover: {
                    actionId: transferred.id,
                    stage: stage.key,
                    firstIdentifiedAt: issue.firstIdentifiedAt.toISOString(),
                    originalOwnerAgentId: issue.assigneeAgentId,
                    returnOwnerAgentId: issue.assigneeAgentId,
                    exactToolOperationReceiptId: operationMatch.success.id,
                    operationEvidenceScope: "exact tool operation only; source objective and production acceptance remain open",
                  },
                },
                issueStateGuard: {
                  statuses: ["backlog", "todo", "in_progress", "in_review", "blocked"],
                  assigneeAgentId: target.id,
                },
              });
            } catch (error) {
              transferWakeError = error instanceof Error ? error.message : String(error);
            }
            const durableTransferWake = await db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
              .from(agentWakeupRequests)
              .where(and(eq(agentWakeupRequests.companyId, issue.companyId), eq(agentWakeupRequests.idempotencyKey, idempotencyKey)))
              .limit(1)
              .then((rows) => rows[0] ?? null);
            const transferWakeAccepted = Boolean(durableTransferWake && !["failed", "cancelled", "skipped"].includes(durableTransferWake.status));
            await db.update(issueRecoveryActions).set({
              evidence: {
                ...transferred.evidence,
                executionSlaDispatch: {
                  status: transferWakeAccepted ? "queued" : "pending",
                  attemptCount: 1,
                  lastAttemptAt: now.toISOString(),
                  wakeRequestId: durableTransferWake?.id ?? null,
                  wakeStatus: durableTransferWake?.status ?? null,
                  lastError: transferWakeError,
                },
              },
              updatedAt: now,
            }).where(and(
              eq(issueRecoveryActions.id, transferred.id),
              eq(issueRecoveryActions.companyId, issue.companyId),
              inArray(issueRecoveryActions.status, ["active", "escalated"]),
            ));
            if (transferWakeAccepted) {
              enqueued += 1;
              if (stage.key === "warning") {
                await db.update(issues).set({ executionSlaWarningAt: now, updatedAt: now }).where(and(
                  eq(issues.id, issue.id), eq(issues.companyId, issue.companyId), isNull(issues.executionSlaWarningAt),
                ));
              }
            }
            await logActivity(db, {
              companyId: issue.companyId,
              actorType: "system",
              actorId: "heartbeat_scheduler",
              action: `issue.execution_sla_${stage.key}_execution_transferred`,
              entityType: "issue",
              entityId: issue.id,
              details: {
                firstIdentifiedAt: issue.firstIdentifiedAt.toISOString(),
                managerAgentId: target.id,
                originalOwnerAgentId: issue.assigneeAgentId,
                recoveryActionKind: "execution_sla_takeover",
                recoveryActionId: transferred.id,
                ownerExecutionWakeRequestId: durableTransferWake?.id ?? null,
                ownerExecutionWakeStatus: durableTransferWake?.status ?? null,
                ownerExecutionWakeError: transferWakeError,
                executionTransferAccepted: transferWakeAccepted,
                failedCallEventId: operationMatch.failed.id,
                matchingSuccessfulCallEventId: operationMatch.success.id,
                operationEvidenceScope: "exact tool operation only; source objective and production acceptance remain open",
              },
            });
            if (transferWakeAccepted) continue;
          }
        }
        const batchKey = `${issue.companyId}:${target.id}:${stage.key}`;
        const batch = batches.get(batchKey) ?? {
          companyId: issue.companyId,
          manager: target,
          stage: stage.key,
          attemptColumn: stage.attemptColumn,
          issues: [],
        };
        batch.issues.push(issue);
        batches.set(batchKey, batch);
      }
    }

    // Coalesce overdue work by capable manager and stage. Preserve one receipt
    // per source issue, while bounding a scheduler tick to one wake per manager.
    for (const batch of batches.values()) {
      const idempotencyWindow = Math.floor(now.getTime() / (5 * 60 * 1000));
      const issueIds = batch.issues.map((issue) => issue.id).sort();
      const idempotencyKey = `execution-sla:${batch.companyId}:${batch.manager.id}:${batch.stage}:${idempotencyWindow}:${issueIds.join(",")}`;
      const wakeReason = `critical_execution_sla_${batch.stage}`;
      let wake: Awaited<ReturnType<typeof enqueueWakeup>> | null = null;
      let dispatchError: string | null = null;
      try {
        wake = await enqueueWakeup(batch.manager.id, {
          source: "automation",
          triggerDetail: "system",
          reason: wakeReason,
          idempotencyKey,
          requestedByActorType: "system",
          requestedByActorId: "heartbeat_scheduler",
          payload: { issueIds },
          contextSnapshot: {
            source: "scheduler",
            wakeReason,
            executionSla: {
              stage: batch.stage,
              managerAgentId: batch.manager.id,
              ownerMustContinueInParallel: true,
              mayCancelOwnerExecution: false,
              issues: batch.issues.map((issue) => ({
                issueId: issue.id,
                identifier: issue.identifier,
                title: issue.title,
                firstIdentifiedAt: issue.firstIdentifiedAt.toISOString(),
                deadlineAt: new Date(issue.firstIdentifiedAt.getTime() + 45 * 60 * 1000).toISOString(),
                originalOwnerAgentId: issue.assigneeAgentId,
              })),
            },
          },
        });
      } catch (error) {
        dispatchError = error instanceof Error ? error.message : String(error);
      }
      const wakeReceipt = await db
        .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, batch.companyId),
          eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const delivered = wakeReceipt && !["skipped", "failed", "cancelled"].includes(wakeReceipt.status);
      if (delivered) {
        enqueued += 1;
        for (const issue of batch.issues) {
          // Warning delivery is a stage marker. A breach wake is only a
          // handoff request: it cannot satisfy the outcome SLA, so keep the
          // breach open for a later result/recovery transition.
          if (batch.attemptColumn === "warning") {
            await db.update(issues)
              .set({ executionSlaWarningAt: now, updatedAt: now })
              .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId), isNull(issues.executionSlaWarningAt)));
          }
          await logActivity(db, {
            companyId: issue.companyId,
            actorType: "system",
            actorId: "heartbeat_scheduler",
            action: `issue.execution_sla_${batch.stage}_wake_accepted`,
            entityType: "issue",
            entityId: issue.id,
            details: {
              firstIdentifiedAt: issue.firstIdentifiedAt.toISOString(),
              deadlineAt: new Date(issue.firstIdentifiedAt.getTime() + 45 * 60 * 1000).toISOString(),
              managerAgentId: batch.manager.id,
              wakeRequestId: wakeReceipt.id,
              wakeRequestStatus: wakeReceipt.status,
              durableWakeReceiptConfirmed: true,
              ...(batch.stage === "breach" ? { slaObligationOpen: true, wakeIsNotTakeoverOrOutcome: true } : {}),
              batchIssueCount: batch.issues.length,
              attemptedAt: now.toISOString(),
            },
          });
        }
      } else {
        skipped += batch.issues.length;
        for (const issue of batch.issues) {
          await logActivity(db, {
            companyId: issue.companyId,
            actorType: "system",
            actorId: "heartbeat_scheduler",
            action: `issue.execution_sla_${batch.stage}_dispatch_failed`,
            entityType: "issue",
            entityId: issue.id,
            details: {
              firstIdentifiedAt: issue.firstIdentifiedAt.toISOString(),
              deadlineAt: new Date(issue.firstIdentifiedAt.getTime() + 45 * 60 * 1000).toISOString(),
              managerAgentId: batch.manager.id,
              wakeRequestId: wakeReceipt?.id ?? null,
              wakeRequestStatus: wakeReceipt?.status ?? null,
              wakeEnqueueReturned: Boolean(wake),
              durableWakeReceiptConfirmed: false,
              dispatchError,
              attemptedAt: now.toISOString(),
            },
          });
        }
      }
    }
    return { checked: dueIssues.length, enqueued, skipped };
  }

  async function tickTimers(now = new Date()) {
      if ((await getSchedulingSuppression()).suppressed) {
        return {
          checked: 0,
          enqueued: 0,
          skipped: 0,
        };
      }
      const cutoff = await getWorktreeExecutionCutoff();

      const allAgents = await db
        .select({ ...getTableColumns(agents) })
        .from(agents)
        .innerJoin(companies, eq(companies.id, agents.companyId))
        .where(eq(companies.status, "active"));
      const agentsByCompany = groupAgentOrgRowsByCompany(
        allAgents.map(toAgentOrgRow),
      );
      const agentById = new Map(allAgents.map((agent) => [agent.id, agent]));
      let checked = 0;
      let enqueued = 0;
      let skipped = 0;

      for (const agent of allAgents) {
        const invokability = evaluateAgentInvokability(
          toAgentOrgRow(agent),
          agentsByCompany.get(agent.companyId) ?? [],
        );
        if (!invokability.invokable) continue;
        const policy = parseHeartbeatPolicy(agent);
        if (!policy.enabled || policy.intervalSec <= 0) continue;

        if (cutoff) {
          const eligibleIssue = await db
            .select({ id: issues.id })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, agent.companyId),
                eq(issues.assigneeAgentId, agent.id),
                inArray(issues.status, ["todo", "in_progress"]),
                gte(issues.createdAt, cutoff),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (!eligibleIssue) continue;
        }

        checked += 1;
        const baseline = new Date(
          agent.lastHeartbeatAt ?? agent.createdAt,
        ).getTime();
        const elapsedMs = now.getTime() - baseline;
        if (elapsedMs < policy.intervalSec * 1000) continue;
        const timerClaim = await claimDueTimerHeartbeat(
          agent,
          now,
          policy.intervalSec,
        );
        if (!timerClaim) continue;

        const run = await enqueueWakeup(agent.id, {
          source: "timer",
          triggerDetail: "system",
          reason: "heartbeat_timer",
          requestedByActorType: "system",
          requestedByActorId: "heartbeat_scheduler",
          contextSnapshot: {
            source: "scheduler",
            reason: "interval_elapsed",
            now: now.toISOString(),
            timerClaimWasFirstHeartbeat: timerClaim.wasFirstHeartbeat,
          },
        });
        if (run) enqueued += 1;
        else skipped += 1;
      }

      const issueMonitors = await tickDueIssueMonitors(now);
      const executionSla = await tickCriticalExecutionSla(now, agentById);

      return {
        checked: checked + issueMonitors.checked + executionSla.checked,
        enqueued: enqueued + issueMonitors.triggered + executionSla.enqueued,
        skipped: skipped + issueMonitors.skipped + executionSla.skipped,
      };
    }

  return {
    triggerIssueMonitor,
    tickTimers,
    recoverActiveSessionGoals,
    recoverPendingSessionGoalActions,
  };
}

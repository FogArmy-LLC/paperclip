import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";

type Run = typeof heartbeatRuns.$inferSelect;

const EXECUTION_EVIDENCE_EVENTS = [
  "adapter.invoke",
  PROCESS_START_REQUESTED,
  PROCESS_IDENTITY_RECORDED,
  "harness.ready",
  "session.started",
  "session.resumed",
  "session.updated",
  "turn.started",
  "provider.event",
  "provider.rpc_result",
  "tool.execution.started",
];

/** A stale continuation ownership check cancels before adapter dispatch. Older
 * builds did not persist an executionCancellation acknowledgement for that
 * path, so lifecycle cleanup must reconstruct the never-started proof from the
 * immutable run record instead of waiting forever for a provider stop receipt. */
export async function isCancelledLegacyContinuationSetup(db: Db, run: Run) {
  const cancellation = run.resultJson?.cancellation as Record<string, unknown> | undefined;
  if (run.status !== "cancelled" || run.runtimeMode !== "legacy" || run.runtimeModeResolvedAt ||
      run.errorCode !== "continuation_task_ownership_changed" || !run.finishedAt ||
      (run.executionStage !== "preparing" && run.executionStage !== "settled") ||
      run.processPid || run.processGroupId || run.processStartedAt || run.sessionIdAfter ||
      (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) ||
      cancellation?.source !== "control_plane" || cancellation?.expected !== true ||
      cancellation?.reason !== "continuation_task_ownership_changed") return false;

  const [lease] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  )).limit(1);
  if (lease) return false;

  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(isNotNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, EXECUTION_EVIDENCE_EVENTS)),
  )).limit(1);
  return !execution;
}

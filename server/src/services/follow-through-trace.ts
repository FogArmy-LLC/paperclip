import { createHash } from "node:crypto";
import { getStartupTraceContext, type StartupTraceContextHandle } from "../instrumentation.js";
import type { ActivityPublication } from "../types/activity-publication.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const STAGES: Record<string, string> = {
  "issue.completion_review_resolved": "review_verdict_recorded",
  "issue.checked_out": "execution_acknowledged",
  "issue.status_decision_recorded": "decision_committed",
  "issue.successful_run_handoff_required": "continuation_required",
  "issue.successful_run_handoff_resolved": "continuation_resolved",
  "issue.successful_run_handoff_escalated": "continuation_escalated",
  "issue.review_path_recovery_queued": "review_recovery_queued",
  "issue.execution_recovery_settled": "recovery_settled",
  "issue.recovery_action_resolved": "recovery_resolved",
  "issue.stalled_review_decided": "review_decision_recorded",
  "issue.work_product_created": "artifact_recorded",
  "issue.work_product_updated": "artifact_updated",
};
const STATUSES = new Set(["backlog", "todo", "in_progress", "blocked", "in_review", "done", "cancelled"]);
const REASONS = new Set(["board_response_waiting", "governed_response_waiting", "scheduled_monitor_waiting", "native_provider_model_rejected", "native_plan_accepted_waiting_for_continuation"]);

/** Pure bounded projection. No comments, prompts, tool arguments, URLs, or arbitrary reason text. */
export function projectFollowThrough(publication: ActivityPublication) {
  if (!UUID.test(publication.companyId)) return null;
  const p = publication.payload;
  const taskId = p.issueId ?? (p.entityType === "issue" ? p.entityId : null);
  if (typeof taskId !== "string" || !UUID.test(taskId)) return null;
  const action = typeof p.action === "string" ? p.action : "";
  const d = record(p.details);
  let stage = STAGES[action];
  if (action === "issue.updated" && d.source === "native_status_decision") stage = "decision_committed";
  if (/^issue\.execution_sla_(warning|breach)_(wake_queued|dispatch_failed|manager_unavailable|execution_transferred)$/.test(action)) {
    stage = `sla_${action.slice("issue.execution_sla_".length)}`;
  }
  if (!stage) return null;
  const attributes: Record<string, string | number | boolean> = {
    "paperclip.task.run.company_id": publication.companyId,
    "paperclip.task.run.task_id": hash(taskId),
    "paperclip.follow_through.schema_version": 1,
    "paperclip.follow_through.stage": stage,
    // A native resolution/status record never implies independent business acceptance.
    "paperclip.follow_through.acceptance": "unverified",
  };
  for (const [key, value] of Object.entries({
    run_id: p.runId, activity_id: p.activityId, owner_id: d.managerAgentId ?? p.agentId,
    decision_id: d.decisionId, source_run_id: d.sourceRunId, next_run_id: d.correctiveRunId ?? d.resolvedByRunId,
  })) {
    if (typeof value === "string" && UUID.test(value)) attributes[key === "run_id" ? "paperclip.task.run.run_id" : `paperclip.follow_through.${key}`] = hash(value);
  }
  if (action === "issue.completion_review_resolved" && ["accepted", "rejected"].includes(String(d.reviewStatus))) {
    attributes["paperclip.follow_through.review_status"] = String(d.reviewStatus);
    attributes["paperclip.follow_through.independent_reviewer"] = d.independentReviewer === true;
  }
  for (const key of ["fromStatus", "toStatus"]) {
    if (typeof d[key] === "string" && STATUSES.has(d[key] as string)) attributes[`paperclip.follow_through.${key}`] = d[key] as string;
  }
  if (typeof d.reasonCode === "string") attributes["paperclip.follow_through.reason"] = REASONS.has(d.reasonCode) ? d.reasonCode : "other";
  for (const key of ["firstIdentifiedAt", "deadlineAt"]) {
    const value = typeof d[key] === "string" ? Date.parse(d[key] as string) : NaN;
    if (Number.isFinite(value)) attributes[`paperclip.follow_through.${key}_ms`] = value;
  }
  for (const key of ["recipientAcknowledged", "correctiveWorkStarted", "correctiveOutcomeAccepted", "slaObligationOpen"]) {
    if (typeof d[key] === "boolean") attributes[`paperclip.follow_through.${key}`] = d[key] as boolean;
  }
  return attributes;
}

/** Export from the publication boundary; never from persistActivity itself. */
export function emitFollowThrough(publication: ActivityPublication, context?: StartupTraceContextHandle) {
  try {
    const attributes = projectFollowThrough(publication);
    if (!attributes) return;
    const span = (context ?? getStartupTraceContext("paperclip.follow-through")).tracer.startSpan("task.follow_through", { attributes });
    span.end();
  } catch {
    // Diagnostic export must not change delivery, retry, permission, or transaction behavior.
  }
}

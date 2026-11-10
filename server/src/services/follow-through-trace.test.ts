import { describe, expect, it } from "vitest";
import { emitFollowThrough, projectFollowThrough } from "./follow-through-trace.js";
import type { ActivityPublication } from "../types/activity-publication.js";

const companyId = "bca6f421-1b87-48b0-b95d-87c073cc7090";
const issueId = "11111111-1111-4111-8111-111111111111";
function event(action: string, details: Record<string, unknown> = {}): ActivityPublication {
  return { companyId, payload: { action, issueId, details, activityId: "45ea2e34-9b3f-48b2-9c70-b26ab0d70e44", runId: "d1464762-dd76-4d52-8566-19e82acce40c" }, pluginEvent: null };
}
describe("post-commit follow-through projection", () => {
  it("joins committed decisions and later handoffs by stable task identity without claiming acceptance", () => {
    const decision = projectFollowThrough(event("issue.updated", { source: "native_status_decision", reasonCode: "board_response_waiting", toStatus: "done" }))!;
    const handoff = projectFollowThrough(event("issue.successful_run_handoff_resolved"))!;
    expect(decision["paperclip.task.run.task_id"]).toBe(handoff["paperclip.task.run.task_id"]);
    expect(decision["paperclip.follow_through.stage"]).toBe("decision_committed");
    expect(handoff["paperclip.follow_through.acceptance"]).toBe("unverified");
    expect(decision["paperclip.follow_through.acceptance"]).toBe("unverified");
  });
  it("preserves original breach time and explicit missing ACK despite repeated queued wakes", () => {
    const d = { firstIdentifiedAt: "2026-11-10T03:40:00Z", deadlineAt: "2026-11-10T04:25:00Z", recipientAcknowledged: false, correctiveOutcomeAccepted: false };
    const first = projectFollowThrough(event("issue.execution_sla_breach_wake_queued", d))!;
    const repeat = projectFollowThrough(event("issue.execution_sla_breach_wake_queued", { ...d, attemptedAt: "2026-11-10T21:00:00Z" }))!;
    expect(first).toEqual(repeat);
    expect(repeat["paperclip.follow_through.recipientAcknowledged"]).toBe(false);
    expect(repeat["paperclip.follow_through.deadlineAt_ms"]).toBe(Date.parse(d.deadlineAt));
  });
  it("does not treat comments, assignments or arbitrary payloads as meaningful progress", () => {
    expect(projectFollowThrough(event("issue.comment_added"))).toBeNull();
    expect(projectFollowThrough(event("issue.updated", { status: "done" }))).toBeNull();
    expect(projectFollowThrough({ ...event("issue.checked_out"), companyId: "secret" })).toBeNull();
  });
  it("exports only bounded names, hashed references and no evidence contents", () => {
    const a = projectFollowThrough(event("issue.status_decision_recorded", { reasonCode: "private prompt", managerAgentId: "secret-owner", toStatus: "secret-status", evidence: "private", url: "private" }))!;
    expect(JSON.stringify(a)).not.toMatch(/private|secret|11111111|d1464762/);
    expect(a["paperclip.follow_through.reason"]).toBe("other");
  });
  it("separates a persisted independent review verdict from business acceptance", () => {
    const a = projectFollowThrough(event("issue.completion_review_resolved", { reviewStatus: "accepted", independentReviewer: true }))!;
    expect(a["paperclip.follow_through.stage"]).toBe("review_verdict_recorded");
    expect(a["paperclip.follow_through.review_status"]).toBe("accepted");
    expect(a["paperclip.follow_through.independent_reviewer"]).toBe(true);
    expect(a["paperclip.follow_through.acceptance"]).toBe("unverified");
  });
  it("keeps export failure diagnostic-only", () => {
    expect(() => emitFollowThrough(event("issue.checked_out"), { tracer: { startSpan() { throw Error("offline"); } } } as never)).not.toThrow();
  });
});

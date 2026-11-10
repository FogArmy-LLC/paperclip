import { describe, expect, it } from "vitest";
import {
  executionSlaRetryDue,
  executionSlaStage,
  matchingExecutionSlaCapabilityReceipt,
  type ExecutionSlaToolReceipt,
} from "./execution-sla.js";

const identifiedAt = new Date("2026-11-10T00:00:00.000Z");
const at = (minutes: number) => new Date(identifiedAt.getTime() + minutes * 60_000);

describe("execution SLA timing", () => {
  it("warns exactly at 30 minutes and breaches exactly at 45 without resetting the clock", () => {
    expect(executionSlaStage({ firstIdentifiedAt: identifiedAt, now: at(29.999), warningAt: null, breachAt: null })).toBeNull();
    expect(executionSlaStage({ firstIdentifiedAt: identifiedAt, now: at(30), warningAt: null, breachAt: null })).toBe("warning");
    expect(executionSlaStage({ firstIdentifiedAt: identifiedAt, now: at(44.999), warningAt: null, breachAt: null })).toBe("warning");
    expect(executionSlaStage({ firstIdentifiedAt: identifiedAt, now: at(45), warningAt: null, breachAt: null })).toBe("breach");
  });

  it("keeps the breach stage open until a result-qualified breach timestamp exists", () => {
    expect(executionSlaStage({ firstIdentifiedAt: identifiedAt, now: at(46), warningAt: null, breachAt: null })).toBe("breach");
    expect(executionSlaStage({ firstIdentifiedAt: identifiedAt, now: at(46), warningAt: at(30), breachAt: null })).toBe("breach");
    // A durable manager wake is not an outcome. The scheduler leaves breachAt
    // null, so the obligation remains visible and retryable.
    expect(executionSlaStage({ firstIdentifiedAt: identifiedAt, now: at(90), warningAt: at(30), breachAt: null })).toBe("breach");
    expect(executionSlaStage({ firstIdentifiedAt: identifiedAt, now: at(60), warningAt: at(30), breachAt: at(45) })).toBeNull();
  });

  it("retries a failed or unavailable dispatch after five minutes without changing first identification", () => {
    expect(executionSlaRetryDue(at(40), at(44.999))).toBe(false);
    expect(executionSlaRetryDue(at(40), at(45))).toBe(true);
    expect(executionSlaRetryDue(null, at(45))).toBe(true);
    expect(identifiedAt.toISOString()).toBe("2026-11-10T00:00:00.000Z");
  });

  it("qualifies only the exact recent operation and project workspace", () => {
    const workspaceId = "project-workspace-1";
    const failed: ExecutionSlaToolReceipt = {
      id: "failed", companyId: "company", issueId: "source", agentId: "owner",
      connectionId: "connection", toolName: "git.push", requestHash: "request-hash",
      outcome: "denied", eventType: "call_denied", createdAt: at(44), projectWorkspaceId: workspaceId,
    };
    const success: ExecutionSlaToolReceipt = {
      ...failed, id: "success", issueId: "prior-work", agentId: "manager",
      outcome: "success", eventType: "call_completed", createdAt: at(20),
    };
    const match = matchingExecutionSlaCapabilityReceipt({
      companyId: "company", sourceIssueId: "source", sourceOwnerAgentId: "owner",
      candidateAgentId: "manager", projectWorkspaceId: workspaceId, blockedSince: at(40), now: at(45),
      maxAgeMs: 30 * 24 * 60 * 60 * 1000, sourceEvents: [failed], candidateEvents: [success],
    });
    expect(match).toMatchObject({ failed: { id: "failed" }, success: { id: "success" } });
    expect(matchingExecutionSlaCapabilityReceipt({
      companyId: "company", sourceIssueId: "source", sourceOwnerAgentId: "owner",
      candidateAgentId: "manager", projectWorkspaceId: "other-workspace", blockedSince: at(40), now: at(45),
      maxAgeMs: 30 * 24 * 60 * 60 * 1000, sourceEvents: [failed], candidateEvents: [success],
    })).toBeNull();
    expect(matchingExecutionSlaCapabilityReceipt({
      companyId: "other-company", sourceIssueId: "source", sourceOwnerAgentId: "owner",
      candidateAgentId: "manager", projectWorkspaceId: workspaceId, blockedSince: at(40), now: at(45),
      maxAgeMs: 30 * 24 * 60 * 60 * 1000, sourceEvents: [failed], candidateEvents: [success],
    })).toBeNull();
    expect(matchingExecutionSlaCapabilityReceipt({
      companyId: "company", sourceIssueId: "source", sourceOwnerAgentId: "owner",
      candidateAgentId: "manager", projectWorkspaceId: workspaceId, blockedSince: at(40), now: at(45),
      maxAgeMs: 30 * 24 * 60 * 60 * 1000,
      sourceEvents: [failed, { ...failed, id: "newer-failure", createdAt: at(44.5), requestHash: "different-request" }],
      candidateEvents: [success],
    })).toBeNull();
    expect(matchingExecutionSlaCapabilityReceipt({
      companyId: "company", sourceIssueId: "source", sourceOwnerAgentId: "owner",
      candidateAgentId: "manager", projectWorkspaceId: workspaceId, blockedSince: at(45), now: at(45),
      maxAgeMs: 30 * 24 * 60 * 60 * 1000, sourceEvents: [failed], candidateEvents: [success],
    })).toBeNull();
  });
});

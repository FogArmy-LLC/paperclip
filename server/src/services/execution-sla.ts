export type ExecutionSlaStage = "warning" | "breach";

export type ExecutionSlaToolReceipt = {
  id: string;
  companyId: string;
  issueId: string | null;
  agentId: string | null;
  connectionId: string | null;
  toolName: string | null;
  requestHash: string | null;
  outcome: string;
  eventType: string;
  createdAt: Date;
  projectWorkspaceId: string | null;
};

/** Match a concrete failed source operation to a recent successful exact-resource execution. */
export function matchingExecutionSlaCapabilityReceipt(input: {
  companyId: string;
  sourceIssueId: string;
  sourceOwnerAgentId: string;
  candidateAgentId: string;
  projectWorkspaceId: string;
  /** The currently blocked transition, if known. Older operation failures are not current evidence. */
  blockedSince: Date | null;
  now: Date;
  maxAgeMs: number;
  sourceEvents: ExecutionSlaToolReceipt[];
  candidateEvents: ExecutionSlaToolReceipt[];
}) {
  if (!input.projectWorkspaceId) return null;
  const recentAfter = input.now.getTime() - input.maxAgeMs;
  const failures = input.sourceEvents.filter((event) =>
    event.companyId === input.companyId &&
    event.issueId === input.sourceIssueId &&
    event.agentId === input.sourceOwnerAgentId &&
    event.projectWorkspaceId === input.projectWorkspaceId &&
    (!input.blockedSince || event.createdAt.getTime() >= input.blockedSince.getTime()) &&
    event.createdAt.getTime() <= input.now.getTime() &&
    ((event.eventType === "call_failed" && event.outcome === "failure") ||
      (event.eventType === "call_denied" && event.outcome === "denied")) &&
    event.connectionId && event.toolName && event.requestHash,
  ).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  // Only the latest failure can describe the operation currently blocking this
  // issue. Falling back to an older failure could transfer work for an unrelated
  // operation after the current failure already disproved candidate capability.
  const failed = failures[0];
  if (!failed) return null;
  const success = input.candidateEvents.find((event) =>
      event.companyId === input.companyId &&
      event.agentId === input.candidateAgentId &&
      event.issueId !== input.sourceIssueId &&
      event.projectWorkspaceId === input.projectWorkspaceId &&
      event.connectionId === failed.connectionId &&
      event.toolName === failed.toolName &&
      event.requestHash === failed.requestHash &&
      event.eventType === "call_completed" &&
      event.outcome === "success" &&
      event.createdAt.getTime() >= recentAfter &&
      event.createdAt.getTime() <= input.now.getTime(),
    );
  return success ? { failed, success } : null;
}

export function executionSlaStage(input: {
  firstIdentifiedAt: Date;
  now: Date;
  warningAt: Date | null;
  breachAt: Date | null;
}): ExecutionSlaStage | null {
  if (input.breachAt) return null;
  const elapsedMs = input.now.getTime() - input.firstIdentifiedAt.getTime();
  if (elapsedMs >= 45 * 60 * 1000) return "breach";
  if (!input.warningAt && elapsedMs >= 30 * 60 * 1000) return "warning";
  return null;
}

export function executionSlaRetryDue(attemptAt: Date | null, now: Date): boolean {
  return !attemptAt || attemptAt.getTime() <= now.getTime() - 5 * 60 * 1000;
}

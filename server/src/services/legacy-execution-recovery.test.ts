import { isPreDispatchReviewWait } from "./pre-dispatch-review-wait.js";
import { expect, it } from "vitest";
import { legacyExecutionNeedsReconciliation } from "./legacy-execution-recovery.js";

const stopped = {
  runtimeMode: "legacy", status: "cancelled", errorCode: "cancelled",
  resultJson: {
    executionCancellation: { state: "acknowledged" },
    executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" },
  },
};

it.each(["workspace_git_scan_timeout", "workspace_git_scan_saturated", "remote_workspace_prepare_timeout"])("does not invent unknown provider actions after exhausted %s bootstrap retries", (errorCode) => {
  const run = { runtimeMode: "legacy", status: "failed", errorCode, scheduledRetryAttempt: 2,
    resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } };
  expect(legacyExecutionNeedsReconciliation(run)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {
    executionRecovery: { kind: "bootstrap", providerWorkStarted: true },
  } })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, errorCode: "setup_failed" })).toBe(true);
});

it("permits subscription waits only with explicit evidence that provider work never started", () => {
  const waiting = {
    runtimeMode: "legacy", status: "cancelled", errorCode: "ai_connection_busy", scheduledRetryAttempt: 12,
    resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } },
  };
  expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, status: "failed" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, errorCode: "cancelled" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {
    executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true },
  } })).toBe(true);
});

it("allows a confirmed interrupted checkpoint without treating ordinary cancellation as replay permission", () => {
  expect(legacyExecutionNeedsReconciliation(stopped)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, status: "failed" })).toBe(true);
});

it.each([
  { providerStopped: false }, { sessionPreserved: false }, { actionOutcomes: "unknown" },
])("retains the hold for incomplete interruption evidence: %j", (missing) => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson,
    executionRecovery: { ...stopped.resultJson.executionRecovery, ...missing },
  } })).toBe(true);
});

it("retains the hold until the provider actually acknowledges cancellation", () => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson, executionCancellation: { state: "requested" },
  } })).toBe(true);
});

 it("continues a conversation without requiring receipts, even after automatic attempts are exhausted", () => {
  for (const status of ["failed", "timed_out", "interrupted", "cancelled"]) {
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy", status, errorCode: "process_lost", scheduledRetryAttempt: 2,
      resultJson: { conversationContinuation: "continue_conversation_v1" },
    })).toBe(false);
  }
});

it("retries a busy AI subscription only when no provider work started", () => {
   const waiting = { runtimeMode: "legacy", status: "cancelled", errorCode: "ai_connection_busy", scheduledRetryAttempt: 10,
     resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } } };
   expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
   expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {} })).toBe(true);
   expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true } } })).toBe(true);
 });


it.each(["failed", "timed_out", "cancelled"])("holds an unsafe archive after %s even with conversation or bootstrap evidence", (status) => {
  expect(legacyExecutionNeedsReconciliation({ runtimeMode: "legacy", status, errorCode: "workspace_restore_failed", resultJson: {
    workspaceRestoreFailure: "restore_unsafe_archive", conversationContinuation: "continue_conversation_v1",
    executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, stopReason: "max_turns",
  } })).toBe(true);
});


it("retains conversation retry eligibility for a transient restore lock timeout", () => {
  expect(legacyExecutionNeedsReconciliation({ runtimeMode: "legacy", status: "failed", errorCode: "workspace_restore_failed", resultJson: {
    workspaceRestoreFailure: "restore_lock_timeout", conversationContinuation: "continue_conversation_v1",
  } })).toBe(false);
});


it("recognizes only an unclaimed pre-dispatch review wait receipt", () => {
  const run = { runtimeMode: "legacy", status: "cancelled", errorCode: "issue_continuation_waiting_on_review",
    startedAt: null, runtimeModeResolvedAt: null, processPid: null, processGroupId: null,
    processStartedAt: null, nativeIssueId: null, nativeSessionId: null, sessionIdAfter: null,
    controllerBootId: null, controllerLeaseExpiresAt: null, executionStage: null,
    resultJson: { stopReason: "issue_continuation_waiting_on_review", timeoutSource: "stale_queued_run_gate" } };
  expect(isPreDispatchReviewWait(run)).toBe(true);
  expect(legacyExecutionNeedsReconciliation(run)).toBe(true);
  for (const patch of [
    { startedAt: new Date() }, { processPid: 123 }, { processGroupId: 123 },
    { processStartedAt: new Date() }, { nativeSessionId: "provider-session" }, { nativeIssueId: "native-task" },
    { sessionIdAfter: "provider-session" }, { runtimeModeResolvedAt: new Date() },
    { controllerBootId: "live-controller" }, { controllerLeaseExpiresAt: new Date() }, { executionStage: "preparing" },
    { errorCode: "operator_interrupted" }, { resultJson: {} },
    { resultJson: { ...run.resultJson, stopReason: "cancelled" } },
    { resultJson: { ...run.resultJson, workspaceRestoreFailure: "restore_unsafe_archive" } },
  ]) expect(isPreDispatchReviewWait({ ...run, ...patch })).toBe(false);
});

it.each(["codex_local", "claude_local", "cursor", "gemini_local"])(
  "exempts %s conversation adapter runs interrupted with retry count < 2 even with null resultJson",
  (adapterType) => {
    const interruptedRun = {
      runtimeMode: "legacy",
      status: "interrupted",
      errorCode: "server_shutdown_interrupted",
      resultJson: null,
      scheduledRetryAttempt: 0,
      runnerProfileJson: {
        adapterDispatch: { adapterType },
      },
    };
    expect(legacyExecutionNeedsReconciliation(interruptedRun)).toBe(false);

    // Also with retry attempt 1
    expect(
      legacyExecutionNeedsReconciliation({
        ...interruptedRun,
        scheduledRetryAttempt: 1,
      }),
    ).toBe(false);

    // Also with process_lost
    expect(
      legacyExecutionNeedsReconciliation({
        ...interruptedRun,
        errorCode: "process_lost",
      }),
    ).toBe(false);

    // Also with execution_reconciliation_required
    expect(
      legacyExecutionNeedsReconciliation({
        ...interruptedRun,
        status: "failed",
        errorCode: "execution_reconciliation_required",
      }),
    ).toBe(false);

    // Also with acknowledged cancelled status
    expect(
      legacyExecutionNeedsReconciliation({
        ...interruptedRun,
        status: "cancelled",
        errorCode: "cancelled",
        resultJson: { executionCancellation: { state: "acknowledged" } },
      }),
    ).toBe(false);
  },
);

it("holds conversation adapter runs once retry count reaches or exceeds 2", () => {
  const exhaustedRun = {
    runtimeMode: "legacy",
    status: "interrupted",
    errorCode: "server_shutdown_interrupted",
    resultJson: null,
    scheduledRetryAttempt: 2,
    runnerProfileJson: {
      adapterDispatch: { adapterType: "codex_local" },
    },
  };
  expect(legacyExecutionNeedsReconciliation(exhaustedRun)).toBe(true);
});

it.each(["process", "webhook", "generic"])(
  "holds non-conversation adapter %s runs on interruption even with retry count < 2",
  (adapterType) => {
    const nonConversationRun = {
      runtimeMode: "legacy",
      status: "interrupted",
      errorCode: "server_shutdown_interrupted",
      resultJson: null,
      scheduledRetryAttempt: 0,
      runnerProfileJson: {
        adapterDispatch: { adapterType },
      },
    };
    expect(legacyExecutionNeedsReconciliation(nonConversationRun)).toBe(true);
  },
);

it("holds runs without runnerProfileJson or adapterDispatch on interruption", () => {
  const unknownRun = {
    runtimeMode: "legacy",
    status: "interrupted",
    errorCode: "server_shutdown_interrupted",
    resultJson: null,
    scheduledRetryAttempt: 0,
    runnerProfileJson: null,
  };
  expect(legacyExecutionNeedsReconciliation(unknownRun)).toBe(true);
});

it("holds unsafe workspace archives even for conversation adapters with retry count < 2", () => {
  const unsafeRun = {
    runtimeMode: "legacy",
    status: "interrupted",
    errorCode: "server_shutdown_interrupted",
    resultJson: { workspaceRestoreFailure: "restore_unsafe_archive" },
    scheduledRetryAttempt: 0,
    runnerProfileJson: {
      adapterDispatch: { adapterType: "codex_local" },
    },
  };
  expect(legacyExecutionNeedsReconciliation(unsafeRun)).toBe(true);
});

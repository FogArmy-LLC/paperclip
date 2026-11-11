import { useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { requiresExecutionReconciliation, type IssueRecoveryAction, type ExecutionReconciliation } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

/** Operator evidence goes through the existing atomic Board-only validator. */
export function ExecutionReconciliationRecovery({ issueId, companyId, action, canManage, onRecorded, className }: {
  issueId: string; companyId: string; action: IssueRecoveryAction | null;
  canManage: boolean; onRecorded: () => void; className?: string;
}) {
  const id = useId();
  const [stopped, setStopped] = useState(false);
  const [outcome, setOutcome] = useState<ExecutionReconciliation["actionOutcome"] | "">("");
  const [evidence, setEvidence] = useState("");
  const [workspaceEvidence, setWorkspaceEvidence] = useState("");
  const runId = action?.evidence.runId ?? action?.evidence.sourceRunId;
  const eligible = Boolean(action && action.companyId === companyId && action.sourceIssueId === issueId
    && action.ownerType === "board" && (["active", "escalated"].includes(action.status)
      || (action.status === "resolved" && !action.evidence.executionReconciliation && (action.evidence.automaticRecovery as { replay?: string } | undefined)?.replay === "blocked"))
    && requiresExecutionReconciliation(action.cause) && typeof runId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId));
  const ready = eligible && canManage && stopped && outcome !== "" && evidence.trim().length >= 20;
  const save = useMutation({
    mutationFn: async () => {
      if (!ready || !action || typeof runId !== "string" || !outcome) throw new Error("Inspect the source run and complete the evidence first.");
      const receipt = await issuesApi.resolveRecoveryAction(issueId, {
        actionId: action.id, outcome: "restored", sourceIssueStatus: "todo",
        executionReconciliation: { runId, providerStopped: true, actionOutcome: outcome,
          outcomeEvidence: evidence.trim(), ...(workspaceEvidence.trim() ? { workspaceRepairEvidence: workspaceEvidence.trim() } : {}) },
      });
      if (receipt.issue.id !== issueId || receipt.issue.companyId !== companyId
        || receipt.recoveryAction.id !== action.id || receipt.recoveryAction.status !== "resolved") {
        throw new Error("The recovery receipt changed. Refresh and inspect the current task.");
      }
      return receipt;
    },
    onSuccess: onRecorded,
  });
  if (!eligible) return null;
  return <section aria-label="Execution reconciliation" className={cn("task-context-notice flex flex-col gap-2", className)}>
    <p className="font-medium">Inspect the stopped execution before retrying</p>
    <p>Source run: <code>{String(runId)}</code>. Record observed provider and action outcomes. This requests a continuation; it does not establish delivery acceptance.</p>
    {!canManage ? <p>A board member with runtime access must reconcile this execution.</p> : <fieldset disabled={save.isPending || save.isSuccess} className="flex flex-col gap-2">
      <Label><input type="checkbox" checked={stopped} onChange={e => setStopped(e.target.checked)} /> I verified that this source run has no active provider execution.</Label>
      <Label htmlFor={`${id}-outcome`}>Observed action outcome</Label>
      <select id={`${id}-outcome`} value={outcome} onChange={e => setOutcome(e.target.value as typeof outcome)}>
        <option value="">Select an observed outcome</option><option value="not_performed">Not performed</option><option value="completed">Completed</option><option value="mixed">Mixed</option>
      </select>
      <Label htmlFor={`${id}-evidence`}>Provider stop and action outcome evidence</Label>
      <Textarea id={`${id}-evidence`} value={evidence} onChange={e => setEvidence(e.target.value)} maxLength={12000} />
      <Label htmlFor={`${id}-workspace`}>Workspace repair evidence, if required</Label>
      <Textarea id={`${id}-workspace`} value={workspaceEvidence} onChange={e => setWorkspaceEvidence(e.target.value)} maxLength={12000} />
      <Button disabled={!ready} onClick={() => save.mutate()}>{save.isPending ? "Recording…" : "Record evidence and request continuation"}</Button>
    </fieldset>}
    {save.isError && <p role="alert">{save.error instanceof Error ? save.error.message : "Reconciliation failed."}</p>}
    {save.isSuccess && <p role="status">Reconciliation recorded. Inspect the next run and its accepted return.</p>}
  </section>;
}

/** Read retained source holds through the existing access-checked endpoint. Never choose an arbitrary run. */
export function ExecutionReconciliationHistory(props: Omit<Parameters<typeof ExecutionReconciliationRecovery>[0], "action"> & { activeAction: IssueRecoveryAction | null }) {
  const history = useQuery({ queryKey: ["execution-reconciliation-history", props.companyId, props.issueId, props.activeAction?.id],
    queryFn: () => issuesApi.recoveryActions(props.issueId), enabled: props.canManage });
  if (history.isError) return <p role="alert">Recovery history could not be read. Refresh before reconciling.</p>;
  const active = history.data?.active ?? props.activeAction;
  const actions = active ? [active] : (history.data?.actions ?? []).filter(action => action.status === "resolved"
    && (action.evidence.automaticRecovery as { replay?: string } | undefined)?.replay === "blocked");
  return <>{actions.map(action => <ExecutionReconciliationRecovery key={`${action.id}:${action.updatedAt}`} {...props} action={action} />)}</>;
}

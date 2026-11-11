// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IssueRecoveryAction } from "@paperclipai/shared";
import { ExecutionReconciliationRecovery, ExecutionReconciliationHistory } from "./ExecutionReconciliationRecovery";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), recorded: vi.fn(), history: vi.fn() }));
vi.mock("../api/issues", () => ({ issuesApi: { resolveRecoveryAction: mocks.resolve, recoveryActions: mocks.history } }));
const runId = "e75eef64-4dcf-407e-bebd-860733847362";
const action = { id: "action", companyId: "company", sourceIssueId: "issue", ownerType: "board", status: "escalated",
  cause: "legacy_execution_requires_reconciliation", evidence: { runId } } as unknown as IssueRecoveryAction;
let container: HTMLDivElement, root: Root, client: QueryClient;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } }); vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ issue: { id: "issue", companyId: "company" }, recoveryAction: { id: "action", status: "resolved" } }); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
async function render(canManage = true, data = action) {
  await act(async () => root.render(<QueryClientProvider client={client}><ExecutionReconciliationRecovery issueId="issue" companyId="company"
    action={data} canManage={canManage} onRecorded={mocks.recorded} /></QueryClientProvider>));
}
async function fill() {
  await act(async () => {
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    const select = container.querySelector('select')!; select.value = 'not_performed'; select.dispatchEvent(new Event('change', { bubbles: true }));
    const textarea = container.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Verified exact run never started; no provider or action execution.');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('requires explicit observations and binds the exact source action and run', async () => {
  await render(); expect(container.querySelector('button')!.disabled).toBe(true); expect(mocks.resolve).not.toHaveBeenCalled();
  await fill(); expect(container.querySelector('button')!.disabled).toBe(false);
  await act(async () => { container.querySelector('button')!.click(); await new Promise(r => setTimeout(r, 0)); });
  expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('issue', { actionId: 'action', outcome: 'restored', sourceIssueStatus: 'todo',
    executionReconciliation: { runId, providerStopped: true, actionOutcome: 'not_performed', outcomeEvidence: 'Verified exact run never started; no provider or action execution.' } });
  expect(mocks.recorded).toHaveBeenCalledOnce();
});
it('keeps runtime authority and tenant/source boundaries', async () => {
  await render(false); expect(container.querySelector('button')).toBeNull();
  for (const patch of [{companyId:'other'}, {sourceIssueId:'other'}, {ownerType:'agent'}, {status:'resolved'}, {cause:'configuration_incomplete'}, {evidence:{runId:'bad'}}]) {
    await render(true, { ...action, ...patch } as IssueRecoveryAction); expect(container.textContent).toBe('');
  }
  expect(mocks.resolve).not.toHaveBeenCalled();
});
it('keeps server conflicts visible and never records a false successful return', async () => {
  mocks.resolve.mockRejectedValue(new Error('The previous provider is still running.'));
  await render(); await fill(); await act(async () => { container.querySelector('button')!.click(); await new Promise(r => setTimeout(r, 0)); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('still running'); expect(mocks.recorded).not.toHaveBeenCalled();
});
it('rejects incomplete or stale response receipts', async () => {
  mocks.resolve.mockResolvedValue({issue:{id:'issue',companyId:'other'},recoveryAction:{id:'action',status:'resolved'}});
  await render(); await fill(); await act(async () => { container.querySelector('button')!.click(); await new Promise(r => setTimeout(r, 0)); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('receipt changed'); expect(mocks.recorded).not.toHaveBeenCalled();
});
it('exposes only a retained resolved replay-blocked source for explicit reconciliation', async () => {
  await render(true, {...action, status:'resolved', evidence:{runId, automaticRecovery:{replay:'blocked'}}} as IssueRecoveryAction);
  expect(container.querySelector('button')!.disabled).toBe(true);
  await fill();
  await act(async () => {container.querySelector('button')!.click(); await new Promise(r=>setTimeout(r,0));});
  expect(mocks.resolve.mock.calls[0][1].actionId).toBe('action');
  expect(mocks.recorded).toHaveBeenCalledOnce();
});

it('reads retained history but does not offer it beside another active action', async () => {
  const retained = {...action, status:'resolved', evidence:{runId, automaticRecovery:{replay:'blocked'}}};
  mocks.history.mockResolvedValue({active:null,actions:[retained]});
  await act(async () => {root.render(<QueryClientProvider client={client}><ExecutionReconciliationHistory issueId="issue" companyId="company" activeAction={null} canManage onRecorded={mocks.recorded}/></QueryClientProvider>); await new Promise(r=>setTimeout(r,20));});
  await act(async()=>{await new Promise(r=>setTimeout(r,20));});
  expect(container.textContent).toContain(runId);
  mocks.history.mockResolvedValue({active:{...action,cause:'deliberate_wait_without_target'},actions:[retained]});
  await act(async()=>{await client.invalidateQueries(); await new Promise(r=>setTimeout(r,20));});
  expect(container.textContent).not.toContain(runId);
  expect(mocks.resolve).not.toHaveBeenCalled();
});

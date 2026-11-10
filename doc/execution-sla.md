# Critical execution SLA

Companies can opt in to the native critical-issue execution SLA through the
existing company settings API:

```http
PATCH /api/companies/{companyId}
Content-Type: application/json

{"executionSlaEnabled": true}
```

The setting is off by default. All nonterminal issues with a recorded blocked
transition in an active company are covered, regardless of department,
assignee type, priority, or later status. Issue creation alone is not a blocker
finding. The first blocked transition is server-owned and immutable; it is not
reset by comments, unblocking, retries, priority changes, or reassignment.
Pre-upgrade blocked issues use their recorded blocked-transition time. A legacy
issue with no blocker event time remains unqualified; creation time is not
substituted.

The existing heartbeat scheduler dispatches a warning to the first invokable
manager in the original assignee's reporting chain after 30 minutes, or the
company root manager when the issue has no agent assignee. At 45 minutes, it
dispatches a breach escalation to the next invokable manager up the same chain
when the warning wake was durably queued, falling back to the closest invokable
manager if no higher manager is available. If a tick first sees the issue after
45 minutes, it sends the breach stage only. Due issues are coalesced by manager
and stage; each issue retains its own immutable clock and activity receipt.
Dispatch failures and unavailable managers remain eligible for retry after a
five-minute backoff. `executionSlaWarningAt` is a durable warning-queue marker;
it does not represent recipient acknowledgement, execution, progress, or
completion. Queueing an escalation is not proof that a manager started or
completed corrective work. The current scheduler selects nonterminal issues;
terminal issue status removes an issue from this timer even though terminal
status alone does not prove a production fix or independent acceptance.

The assignee continues working in parallel. After the 30-minute warning
threshold or 45-minute breach threshold, the scheduler may transfer assignment
only when a current failed source operation matches a recent successful
operation by a same-company candidate in the same workspace, current grants
still authorize it, the issue-read boundary is rechecked under lock, and no
active run, workspace operation, or recovery action fences writes. The
transfer's wake receipt is still only queued work; it is not a recipient ACK,
execution start, meaningful progress, fix, independent acceptance, production
application, or return to the original owner. If qualification fails, the
manager escalation remains an open handoff obligation and the original
assignment remains unchanged. The SLA does not cancel productive runs, grant
permissions, approve a protected action, or bypass deployment, deletion,
security, or production gates. This implementation enforces identification,
escalation, and a guarded takeover foundation; it does not enforce a complete
45-minute identification-to-RCA-to-production outcome contract or preserve
that obligation after a source issue becomes terminal. Do not treat wake
delivery, issue status, or assignment transfer as acceptance of that contract.

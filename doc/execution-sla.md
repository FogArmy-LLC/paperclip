# Critical execution SLA

Companies can opt in to the native critical-issue execution SLA through the
existing company settings API:

```http
PATCH /api/companies/{companyId}
Content-Type: application/json

{"executionSlaEnabled": true}
```

The setting is off by default. All nonterminal issues in an active company are
covered, regardless of department, assignee type, priority, or status. The
first-identified clock is server-owned and immutable; it is not reset by
comments, status changes, retries, priority changes, or reassignment. For
pre-upgrade issues with no recorded transition, the issue creation time is the
earliest available clock evidence.

The existing heartbeat scheduler dispatches a warning to the first invokable
manager in the original assignee's reporting chain after 30 minutes, or the
company root manager when the issue has no agent assignee. At 45 minutes, it
dispatches a breach escalation to the next invokable manager up the same chain,
falling back to the closest invokable manager if no higher manager is
available. If a tick first sees the issue after 45 minutes, it sends the breach
stage only. Due issues are coalesced by manager and stage; each issue retains
its own immutable clock and activity receipt. Dispatch failures and unavailable
managers remain eligible for retry after a five-minute backoff. The stage's
issue timestamp is written only after a durable, nonterminal wake request is
read back from the queue. Queueing is an escalation receipt, not proof that a
manager started or completed corrective work.

The assignee remains the owner and continues working in parallel. The SLA does
not cancel productive runs, change assignment, grant permissions, approve a
protected action, or bypass deployment, deletion, security, or production gates.
An escalation is an intervention request, not proof that the underlying work
was completed; the existing acceptance and production evidence remain required.

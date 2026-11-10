import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import {
  costEvents,
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  projects,
  projectWorkspaces,
  toolApplications,
  toolConnections,
  connectionGrants,
  issueAccessGrants,
  toolConnectionInstalls,
  toolCatalogEntries,
  toolProfiles,
  toolProfileEntries,
  toolProfileBindings,
  toolCallEvents,
  issueDocuments,
  issues,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../services/issue-execution-policy.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue monitor scheduler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue monitor scheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const seededAgentIds = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-monitor-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  async function waitForHeartbeatIdle(timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
      if (active.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat runs to settle");
  }

  async function heartbeatSideEffectFingerprint() {
    const [active, events, activity, leases, runtimeServices] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`),
      db.select({ count: sql<number>`count(*)` }).from(heartbeatRunEvents),
      db.select({ count: sql<number>`count(*)` }).from(activityLog),
      db.select({ count: sql<number>`count(*)` }).from(environmentLeases),
      db.select({ count: sql<number>`count(*)` }).from(workspaceRuntimeServices),
    ]);

    return [
      active[0]?.count ?? 0,
      events[0]?.count ?? 0,
      activity[0]?.count ?? 0,
      leases[0]?.count ?? 0,
      runtimeServices[0]?.count ?? 0,
    ].join(":");
  }

  async function waitForHeartbeatSideEffectsSettled(timeoutMs = 5_000, quietMs = 500) {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const current = await heartbeatSideEffectFingerprint();
      const activeCount = Number(current.split(":")[0] ?? 0);
      if (current !== previous || activeCount > 0) {
        previous = current;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= quietMs) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat side effects to settle");
  }

  async function cleanupRows() {
    await waitForHeartbeatSideEffectsSettled();
    await db.delete(heartbeatRunEvents);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(issues);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  afterEach(async () => {
    // The no-op process fixtures deliberately leave no task disposition. The
    // real lifecycle can now leave a bounded, scheduled repair after the
    // monitor assertions. Cancel that remaining work only during teardown.
    const heartbeat = heartbeatService(db);
    await heartbeat.drainActiveRunExecutions();
    const pending = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
    for (const run of pending) await heartbeat.cancelRun(run.id, "Monitor fixture teardown", { suppressImmediateRecovery: true });
    await heartbeat.drainActiveRunExecutions();
    seededAgentIds.clear();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await cleanupRows();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(input?: {
    agentStatus?: "active" | "paused";
    issueStatus?: "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
    monitorAttemptCount?: number;
    monitor?: Record<string, unknown>;
    executionSlaEnabled?: boolean;
    critical?: boolean;
    createdAt?: Date;
    withManager?: boolean;
    managerStatus?: "active" | "paused";
    managerReportsToAlternate?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const nextCheckAt = input?.monitor?.nextCheckAt
      ? new Date(String(input.monitor.nextCheckAt))
      : new Date("2026-04-11T12:30:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    const monitorAttemptCount = input?.monitorAttemptCount ?? 0;
    const monitor = {
      nextCheckAt: nextCheckAt.toISOString(),
      notes: "Check deploy",
      scheduledBy: "assignee",
      ...(input?.monitor ?? {}),
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
      executionSlaEnabled: input?.executionSlaEnabled ?? false,
    });

    const alternateManagerId = input?.withManager && input.managerReportsToAlternate
      ? randomUUID()
      : null;
    if (alternateManagerId) {
      await db.insert(agents).values({
        id: alternateManagerId,
        companyId,
        name: "Alternate Manager Bot",
        role: "manager",
        status: "active",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
        permissions: {},
      });
    }

    const managerId = input?.withManager ? randomUUID() : null;
    if (managerId) {
      await db.insert(agents).values({
        id: managerId,
        companyId,
        name: "Manager Bot",
        role: "manager",
        status: input?.managerStatus ?? "active",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
        permissions: {},
        reportsTo: alternateManagerId,
      });
    }

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Monitor Bot",
      role: "engineer",
      status: input?.agentStatus ?? "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
        },
      },
      permissions: {},
      reportsTo: managerId,
    });
    seededAgentIds.add(agentId);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Watch external deploy",
      status: input?.issueStatus ?? "in_progress",
      priority: input?.critical ? "critical" : "medium",
      ...(input?.createdAt ? { createdAt: input.createdAt } : {}),
      ...(input?.issueStatus === "blocked"
        ? { executionSlaFirstIdentifiedAt: input.createdAt ?? new Date() }
        : {}),
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor,
      },
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "scheduled",
          nextCheckAt: nextCheckAt.toISOString(),
          lastTriggeredAt: null,
          attemptCount: monitorAttemptCount,
          notes: "Check deploy",
          scheduledBy: "assignee",
          serviceName: typeof monitor.serviceName === "string" ? monitor.serviceName : null,
          externalRef: typeof monitor.externalRef === "string" ? monitor.externalRef : null,
          timeoutAt: typeof monitor.timeoutAt === "string" ? monitor.timeoutAt : null,
          maxAttempts: typeof monitor.maxAttempts === "number" ? monitor.maxAttempts : null,
          recoveryPolicy: typeof monitor.recoveryPolicy === "string" ? monitor.recoveryPolicy : null,
          clearedAt: null,
          clearReason: null,
        },
      },
      monitorNextCheckAt: nextCheckAt,
      monitorAttemptCount,
      monitorNotes: "Check deploy",
      monitorScheduledBy: "assignee",
    });

    return { companyId, agentId, issueId, nextCheckAt };
  }

  it("warns the manager at 30 minutes and escalates at 45 for ordinary-priority work from the immutable clock", async () => {
    const firstIdentifiedAt = new Date("2026-04-11T12:00:00.000Z");
    const { companyId, agentId, issueId } = await seedFixture({
      executionSlaEnabled: true,
      issueStatus: "blocked",
      createdAt: firstIdentifiedAt,
      withManager: true,
      managerReportsToAlternate: true,
      monitor: { nextCheckAt: "2027-04-11T12:30:00.000Z" },
    });
    const managerId = await db.select({ id: agents.id }).from(agents)
      .where(sql`${agents.companyId} = ${companyId} and ${agents.name} = 'Manager Bot'`)
      .then(rows => rows[0]!.id);
    const alternateManagerId = await db.select({ id: agents.id }).from(agents)
      .where(sql`${agents.companyId} = ${companyId} and ${agents.name} = 'Alternate Manager Bot'`)
      .then(rows => rows[0]!.id);
    const heartbeat = heartbeatService(db);

    expect((await heartbeat.tickTimers(new Date("2026-04-11T12:29:59.999Z"))).enqueued).toBe(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);

    await heartbeat.tickTimers(new Date("2026-04-11T12:30:00.000Z"));
    const warningWake = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, managerId));
    expect(warningWake).toHaveLength(1);
    expect(warningWake[0]?.reason).toBe("critical_execution_sla_warning");
    expect(warningWake[0]?.idempotencyKey).toContain(`execution-sla:${companyId}:${managerId}:warning:`);
    expect(warningWake[0]?.payload).toMatchObject({ issueIds: [issueId] });

    // Repeating the scheduler tick cannot duplicate the warning or reset the clock.
    await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, managerId))).toHaveLength(1);
    const [warningReceipt] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(warningReceipt.createdAt.toISOString()).toBe(firstIdentifiedAt.toISOString());
    expect(warningReceipt.executionSlaFirstIdentifiedAt?.toISOString()).toBe(firstIdentifiedAt.toISOString());
    expect(warningReceipt.executionSlaWarningAt?.toISOString()).toBe("2026-04-11T12:30:00.000Z");
    expect(warningReceipt.assigneeAgentId).toBe(agentId);

    await heartbeat.tickTimers(new Date("2026-04-11T12:44:59.999Z"));
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, managerId))).toHaveLength(1);
    await heartbeat.tickTimers(new Date("2026-04-11T12:45:00.000Z"));
    const dispatched = await db.select().from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.companyId} = ${companyId} and ${agentWakeupRequests.reason} like 'critical_execution_sla_%'`);
    expect(dispatched.map(row => row.reason)).toEqual([
      "critical_execution_sla_warning",
      "critical_execution_sla_breach",
    ]);
    expect(dispatched[0]?.agentId).toBe(managerId);
    expect(dispatched[1]?.agentId).toBe(alternateManagerId);
    expect(dispatched[1]?.payload).toMatchObject({ issueIds: [issueId] });
    await heartbeat.tickTimers(new Date("2026-04-11T12:46:00.000Z"));
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, managerId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, alternateManagerId))).toHaveLength(1);
    const [breachReceipt] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(breachReceipt.executionSlaBreachAt).toBeNull();
    expect(breachReceipt.assigneeAgentId).toBe(agentId);
  });

  it("keeps execution SLA opt-in and excludes terminal or cross-company issues", async () => {
    const firstIdentifiedAt = new Date("2026-04-11T12:00:00.000Z");
    const enabled = await seedFixture({ executionSlaEnabled: true, issueStatus: "blocked", createdAt: firstIdentifiedAt, withManager: true, monitor: { nextCheckAt: "2027-04-11T12:30:00.000Z" } });
    const notIdentified = await seedFixture({ executionSlaEnabled: true, issueStatus: "in_progress", createdAt: firstIdentifiedAt, withManager: true, monitor: { nextCheckAt: "2027-04-11T12:30:00.000Z" } });
    const disabled = await seedFixture({ executionSlaEnabled: false, issueStatus: "blocked", createdAt: firstIdentifiedAt, withManager: true, monitor: { nextCheckAt: "2027-04-11T12:30:00.000Z" } });
    const terminal = await seedFixture({ executionSlaEnabled: true, issueStatus: "done", createdAt: firstIdentifiedAt, withManager: true, monitor: { nextCheckAt: "2027-04-11T12:30:00.000Z" } });

    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:45:00.000Z"));
    const enabledWakes = await db.select().from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.companyId} = ${enabled.companyId} and ${agentWakeupRequests.reason} like 'critical_execution_sla_%'`);
    expect(enabledWakes.map(row => row.reason)).toEqual(["critical_execution_sla_breach"]);
    expect(await db.select().from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.companyId} = ${disabled.companyId} and ${agentWakeupRequests.reason} like 'critical_execution_sla_%'`)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.companyId} = ${notIdentified.companyId} and ${agentWakeupRequests.reason} like 'critical_execution_sla_%'`)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.companyId} = ${terminal.companyId} and ${agentWakeupRequests.reason} like 'critical_execution_sla_%'`)).toHaveLength(0);
  });

  it("transfers an approaching-SLA issue only with an exact failed operation, matching scoped success, and current grants", async () => {
    const firstIdentifiedAt = new Date("2026-04-11T12:00:00.000Z");
    const seeded = await seedFixture({
      executionSlaEnabled: true,
      issueStatus: "blocked",
      createdAt: firstIdentifiedAt,
      withManager: true,
      managerReportsToAlternate: true,
    });
    const managerId = await db.select({ id: agents.id }).from(agents)
      .where(sql`${agents.companyId} = ${seeded.companyId} and ${agents.name} = 'Manager Bot'`)
      .then(rows => rows[0]!.id);
    const alternateManagerId = await db.select({ id: agents.id }).from(agents)
      .where(sql`${agents.companyId} = ${seeded.companyId} and ${agents.name} = 'Alternate Manager Bot'`)
      .then(rows => rows[0]!.id);
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const profileId = randomUUID();
    const issuePrefix = `T${seeded.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(projects).values({ id: projectId, companyId: seeded.companyId, name: "Source project", status: "in_progress" });
    await db.insert(projectWorkspaces).values({ id: workspaceId, companyId: seeded.companyId, projectId, name: "registered repo", repoUrl: "https://github.com/example/registered", defaultRef: "main", isPrimary: true });
    await db.update(issues).set({ projectId, projectWorkspaceId: workspaceId }).where(eq(issues.id, seeded.issueId));
    await db.insert(issues).values({
      companyId: seeded.companyId, projectId, projectWorkspaceId: workspaceId,
      title: "Prior exact operation", status: "done", assigneeAgentId: managerId,
      issueNumber: 2, identifier: `${issuePrefix}-2`,
    });
    await db.insert(toolApplications).values({ id: applicationId, companyId: seeded.companyId, name: "GitHub", type: "mcp_http", status: "active" });
    await db.insert(toolConnections).values({
      id: connectionId, companyId: seeded.companyId, applicationId, name: "Registered GitHub",
      uid: "registered-github", transport: "mcp_remote", connectionPurpose: "tool",
      authKind: "none", status: "active", enabled: true, credentialPolicy: "shared",
    });
    await db.insert(connectionGrants).values({ companyId: seeded.companyId, connectionId, kind: "organization", status: "active" });
    await db.insert(toolConnectionInstalls).values({ companyId: seeded.companyId, connectionId, targetType: "company", targetId: seeded.companyId });
    const [catalogEntry] = await db.insert(toolCatalogEntries).values({
      companyId: seeded.companyId, applicationId, connectionId, name: "push", toolName: "github.push",
      versionHash: "catalog-v1", status: "active", riskLevel: "write", isReadOnly: false, isWrite: true,
    }).returning();
    await db.insert(toolProfiles).values({ id: profileId, companyId: seeded.companyId, profileKey: "manager-github", name: "Manager GitHub", status: "active", defaultAction: "deny" });
    await db.insert(toolProfileEntries).values({ companyId: seeded.companyId, profileId, selectorType: "catalog_entry", effect: "include", catalogEntryId: catalogEntry!.id });
    await db.insert(toolProfileBindings).values({ companyId: seeded.companyId, profileId, targetType: "agent", targetId: alternateManagerId });
    const requestHash = "same-protected-operation";
    const [prior] = await db.select({ id: issues.id }).from(issues).where(eq(issues.identifier, `${issuePrefix}-2`));
    await db.insert(toolCallEvents).values([
      { companyId: seeded.companyId, issueId: seeded.issueId, agentId: seeded.agentId, connectionId, toolName: "github.push", requestHash, eventType: "call_denied", outcome: "denied", createdAt: new Date("2026-04-11T12:20:00.000Z") },
      { companyId: seeded.companyId, issueId: prior!.id, agentId: alternateManagerId, connectionId, toolName: "github.push", requestHash, eventType: "call_completed", outcome: "success", createdAt: new Date("2026-04-10T12:00:00.000Z") },
    ]);

    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:30:00.000Z"));
    const [reassigned] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(reassigned!.assigneeAgentId).toBe(alternateManagerId);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, seeded.issueId)))
      .toMatchObject([expect.objectContaining({ kind: "execution_sla_takeover", previousOwnerAgentId: seeded.agentId, returnOwnerAgentId: seeded.agentId, ownerAgentId: alternateManagerId, status: "active" })]);
    expect(await db.select().from(agentWakeupRequests).where(sql`${agentWakeupRequests.companyId} = ${seeded.companyId} and ${agentWakeupRequests.reason} = 'issue_assigned'`))
      .toMatchObject([expect.objectContaining({ agentId: alternateManagerId, payload: expect.objectContaining({ issueId: seeded.issueId, source: "execution_sla_takeover" }) })]);
    const [warningStage] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(warningStage!.executionSlaWarningAt?.toISOString()).toBe("2026-04-11T12:30:00.000Z");

    await waitForHeartbeatIdle();
    const [firstWake] = await db.select().from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.companyId} = ${seeded.companyId} and ${agentWakeupRequests.reason} = 'issue_assigned'`);
    await db.update(agentWakeupRequests).set({ status: "failed", error: "Injected dispatch failure" })
      .where(eq(agentWakeupRequests.id, firstWake!.id));
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:36:00.000Z"));
    const retriedWakes = await db.select().from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.companyId} = ${seeded.companyId} and ${agentWakeupRequests.reason} = 'issue_assigned'`);
    const retryWake = retriedWakes.find((row) => row.id !== firstWake?.id);
    expect(retriedWakes).toHaveLength(2);
    expect(retryWake?.agentId).toBe(alternateManagerId);
    expect(retryWake?.idempotencyKey).not.toBe(firstWake?.idempotencyKey);
    const [recovery] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, seeded.issueId));
    expect(recovery?.evidence.executionSlaDispatch).toMatchObject({ status: "queued", wakeRequestId: retryWake!.id });
  });

  it("records an unavailable manager, preserves the original deadline, and retries after capability recovery", async () => {
    const firstIdentifiedAt = new Date("2026-04-11T12:00:00.000Z");
    const { companyId, issueId } = await seedFixture({
      executionSlaEnabled: true,
      issueStatus: "blocked",
      createdAt: firstIdentifiedAt,
      withManager: true,
      managerStatus: "paused",
      monitor: { nextCheckAt: "2027-04-11T12:30:00.000Z" },
    });
    const managerId = await db.select({ id: agents.id }).from(agents)
      .where(sql`${agents.companyId} = ${companyId} and ${agents.name} = 'Manager Bot'`)
      .then(rows => rows[0]!.id);
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:45:00.000Z"));
    expect(await db.select().from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.companyId} = ${companyId} and ${agentWakeupRequests.reason} like 'critical_execution_sla_%'`)).toHaveLength(0);
    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(events.map(row => row.action)).toContain("issue.execution_sla_breach_manager_unavailable");
    const [receipt] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(receipt.createdAt.toISOString()).toBe(firstIdentifiedAt.toISOString());
    expect(receipt.executionSlaBreachAt).toBeNull();
    expect(receipt.executionSlaBreachAttemptAt?.toISOString()).toBe("2026-04-11T12:45:00.000Z");

    await db.update(agents).set({ status: "active" }).where(eq(agents.id, managerId));
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:50:00.000Z"));
    const wakes = await db.select().from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.companyId} = ${companyId} and ${agentWakeupRequests.reason} = 'critical_execution_sla_breach'`);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.payload).toMatchObject({ issueIds: [issueId] });
    const [retried] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(retried.executionSlaFirstIdentifiedAt?.toISOString()).toBe(firstIdentifiedAt.toISOString());
    expect(retried.executionSlaBreachAt).toBeNull();
    expect(retried.executionSlaBreachAttemptAt?.toISOString()).toBe("2026-04-11T12:50:00.000Z");
  });

  it("does not disclose private issue context to an ungranted same-company manager", async () => {
    const { companyId, issueId } = await seedFixture({
      executionSlaEnabled: true,
      issueStatus: "blocked",
      createdAt: new Date("2026-04-11T12:00:00.000Z"),
      withManager: true,
    });
    await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, issueId));

    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:45:00.000Z"));

    expect(await db.select().from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.companyId} = ${companyId} and ${agentWakeupRequests.reason} like 'critical_execution_sla_%'`))
      .toHaveLength(0);
    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(events.map(row => row.action)).toContain("issue.execution_sla_breach_manager_unavailable");
    expect(events.some(row => JSON.stringify(row.details).includes("Watch external deploy"))).toBe(false);
  });

  it("rechecks private issue access under the ownership lock after candidate precheck", async () => {
    const { companyId, agentId, issueId } = await seedFixture({
      executionSlaEnabled: true,
      issueStatus: "blocked",
      createdAt: new Date("2026-04-11T12:00:00.000Z"),
      withManager: true,
    });
    const managerId = await db.select({ id: agents.id }).from(agents)
      .where(sql`${agents.companyId} = ${companyId} and ${agents.name} = 'Manager Bot'`)
      .then(rows => rows[0]!.id);
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Private source project", status: "in_progress" });
    await db.insert(projectWorkspaces).values({ id: workspaceId, companyId, projectId, name: "registered repo", repoUrl: "https://github.com/example/registered", defaultRef: "main", isPrimary: true });
    await db.update(issues).set({ projectId, projectWorkspaceId: workspaceId, visibility: "private" }).where(eq(issues.id, issueId));
    const [grant] = await db.insert(issueAccessGrants).values({
      issueId,
      subjectType: "agent",
      subjectId: managerId,
      source: "explicit",
    }).returning({ id: issueAccessGrants.id });

    // The scheduler's first transaction is the ownership transfer, after the
    // target passed its candidate-read precheck. Revoke the access grant in
    // that gap and let the locked transaction prove it revalidates ACL.
    const dbWithTransaction = db as unknown as {
      transaction: (callback: (tx: unknown) => Promise<unknown>, config?: unknown) => Promise<unknown>;
    };
    const originalTransaction = dbWithTransaction.transaction.bind(db);
    let revokedBetweenChecks = false;
    dbWithTransaction.transaction = async (callback, config) => {
      if (!revokedBetweenChecks) {
        revokedBetweenChecks = true;
        await db.update(issueAccessGrants).set({ revokedAt: new Date("2026-04-11T12:30:00.000Z") })
          .where(eq(issueAccessGrants.id, grant!.id));
      }
      dbWithTransaction.transaction = originalTransaction;
      return originalTransaction(callback, config);
    };

    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:30:00.000Z"));

    expect(revokedBetweenChecks).toBe(true);
    expect(await db.select().from(issues).where(eq(issues.id, issueId)))
      .toMatchObject([expect.objectContaining({ assigneeAgentId: agentId, visibility: "private" })]);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.companyId} = ${companyId} and ${agentWakeupRequests.reason} = 'issue_assigned'`))
      .toHaveLength(0);
  });

  it("triggers due issue monitors once and clears the one-shot schedule", async () => {
    const { issueId, agentId } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");
    const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
    const unrelatedPolicy = { commentRequired: false, futureAuthorization: { preserve: true } };
    await db.update(issues).set({ executionPolicy: { ...before.executionPolicy, ...unrelatedPolicy } }).where(eq(issues.id, issueId));

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.executionPolicy).toMatchObject(unrelatedPolicy);
    expect(issue.monitorAttemptCount).toBe(1);
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(tickAt.toISOString());
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "triggered",
      lastTriggeredAt: tickAt.toISOString(),
      attemptCount: 1,
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_triggered");
  });

  it("preserves a due monitor through native execution and dispatches once after release", async () => {
    const { companyId, issueId, agentId, nextCheckAt } = await seedFixture();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "running", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const heartbeat = heartbeatService(db);
    expect((await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"))).enqueued).toBe(0);
    const [waiting] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(waiting.monitorNextCheckAt).toEqual(nextCheckAt);
    expect(waiting.monitorWakeRequestedAt).toBeNull();
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
    expect((await heartbeat.tickTimers(new Date("2026-04-11T12:32:00.000Z"))).enqueued).toBe(1);
    expect((await heartbeat.tickTimers(new Date("2026-04-11T12:33:00.000Z"))).enqueued).toBe(0);
    const [triggered] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(triggered.monitorNextCheckAt).toBeNull();
    expect(triggered.monitorAttemptCount).toBe(1);
    expect((await db.select().from(agentWakeupRequests)).filter(wake => wake.reason === "issue_monitor_due")).toHaveLength(1);
  });

  it.each(["replaced", "cleared", "reassigned", "completed"] as const)("fences a monitor %s after claim but before wake admission", async (change) => {
    const { companyId, issueId, agentId } = await seedFixture();
    const replacementAt = new Date("2026-04-11T13:30:00.000Z");
    let raced = false;
    const racingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return async (callback: Parameters<typeof db.transaction>[0]) => {
          const result = await db.transaction(callback);
          const claimed = result as { id?: string; monitorWakeRequestedAt?: Date } | undefined;
          if (!raced && claimed?.id === issueId && claimed.monitorWakeRequestedAt) {
            raced = true;
            await db.update(issues).set(change === "replaced" ? {
              monitorNextCheckAt: replacementAt, monitorWakeRequestedAt: null,
              executionPolicy: { monitor: { nextCheckAt: replacementAt.toISOString(), notes: "Replacement check", scheduledBy: "assignee" } },
            } : change === "cleared" ? { monitorNextCheckAt: null, monitorWakeRequestedAt: null, executionPolicy: null }
              : change === "reassigned" ? { assigneeAgentId: null } : { status: "done" })
              .where(eq(issues.id, issueId));
          }
          return result;
        };
      },
    });
    expect((await heartbeatService(racingDb).tickTimers(new Date("2026-04-11T12:31:00.000Z"))).enqueued).toBe(0);
    expect(raced).toBe(true);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)))
      .filter(wake => wake.reason === "issue_monitor_due")).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    if (change === "replaced") expect(issue.monitorNextCheckAt).toEqual(replacementAt);
    if (change === "cleared") expect(issue.monitorNextCheckAt).toBeNull();
  });

  it("does not erase a replacement scheduled after wake admission", async () => {
    const { companyId, issueId } = await seedFixture();
    const nextCheckAt = new Date("2026-04-11T13:30:00.000Z");
    let replaced = false;
    const racingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return async (callback: Parameters<typeof db.transaction>[0]) => {
          const result = await db.transaction(callback);
          if (!replaced && (result as { kind?: string } | undefined)?.kind === "queued") {
            replaced = true;
            await db.update(issues).set({ monitorNextCheckAt: nextCheckAt, monitorWakeRequestedAt: null,
              executionPolicy: { monitor: { nextCheckAt: nextCheckAt.toISOString(), notes: "New check", scheduledBy: "assignee" } },
            }).where(eq(issues.id, issueId));
          }
          return result;
        };
      },
    });
    await heartbeatService(racingDb).tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    expect(replaced).toBe(true);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.monitorNextCheckAt).toEqual(nextCheckAt);
    expect(issue.monitorWakeRequestedAt).toBeNull();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)))
      .filter(wake => wake.reason === "issue_monitor_due")).toHaveLength(1);
  });

  it.each(["unknown", "exhausted"] as const)("does not replay a quota monitor with %s execution evidence", async (kind) => {
    const sourceRunId = randomUUID();
    const { companyId, issueId, agentId } = await seedFixture({
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: sourceRunId },
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId, status: "failed", errorCode: "provider_quota",
      finishedAt: new Date("2026-04-11T12:00:00.000Z"), contextSnapshot: { issueId },
      scheduledRetryAttempt: kind === "exhausted" ? 2 : 0,
      resultJson: kind === "exhausted" ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } : null,
    });
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select().from(issueRecoveryActions)).toMatchObject([{ ownerType: "board", evidence: { runId: sourceRunId } }]);
  });

  it("wakes a cross-agent review participant for provider quota monitors", async () => {
    const sourceRunId = randomUUID();
    const { companyId, issueId, agentId: assigneeAgentId } = await seedFixture({
      issueStatus: "in_review",
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: sourceRunId },
    });
    const participantAgentId = randomUUID();
    await db.insert(agents).values({
      id: participantAgentId,
      companyId,
      name: "Quota-limited reviewer",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    seededAgentIds.add(participantAgentId);
    const monitorState = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => parseIssueExecutionState(rows[0]?.executionState ?? null)?.monitor ?? null);
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: participantAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: assigneeAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: monitorState,
      },
    }).where(eq(issues.id, issueId));
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId: participantAgentId, status: "failed",
      errorCode: "provider_quota", finishedAt: new Date("2026-04-11T12:00:00.000Z"),
      contextSnapshot: { issueId },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");
    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      agentId: participantAgentId,
      reason: "execution_review_participant_recovery",
    });
    const [scheduled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, sourceRunId));
    expect(scheduled).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
    expect(await heartbeat.promoteDueScheduledRetries(scheduled.scheduledRetryAt!)).toMatchObject({ promoted: 1 });
    await heartbeat.resumeQueuedRuns();
    await waitForHeartbeatIdle();
    const participantRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, participantAgentId));
    expect(participantRuns).toHaveLength(2);
    expect(participantRuns.find((run) => run.id === scheduled.id)?.errorCode).not.toBe("issue_assignee_changed");
  });

  it("lets the board trigger a scheduled issue monitor immediately", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const triggeredAt = new Date("2026-04-11T12:00:00.000Z");

    const result = await heartbeat.triggerIssueMonitor(issueId, {
      now: triggeredAt,
      actorType: "user",
      actorId: "local-board",
    });

    expect(result.outcome).toBe("triggered");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(triggeredAt.toISOString());
    expect(issue.monitorAttemptCount).toBe(1);
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .orderBy(activityLog.createdAt);
    expect(activity.map((row) => row.action)).toContain("issue.monitor_triggered");
    const triggerEvent = activity.find((row) => row.action === "issue.monitor_triggered");
    expect(triggerEvent?.actorType).toBe("user");
    expect(triggerEvent?.actorId).toBe("local-board");
    expect(triggerEvent?.details).toMatchObject({
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });
  });

  it("clears due monitors that cannot be dispatched and records a skip", async () => {
    const { issueId } = await seedFixture({ agentStatus: "paused" });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "dispatch_skipped",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_skipped");
  });

  it("clears exhausted monitors and queues bounded owner recovery instead of another due check", async () => {
    const { issueId, agentId } = await seedFixture({
      monitorAttemptCount: 1,
      monitor: {
        maxAttempts: 1,
        recoveryPolicy: "wake_owner",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "max_attempts_exhausted",
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_recovery");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      clearReason: "max_attempts_exhausted",
      maxAttempts: 1,
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_exhausted");
    expect(activity).toContain("issue.monitor_recovery_wake_queued");
    expect(activity).not.toContain("issue.monitor_triggered");
  });

  it("clears timed-out monitors and creates a visible recovery issue when requested", async () => {
    const { issueId, companyId } = await seedFixture({
      monitor: {
        timeoutAt: "2026-04-11T12:00:00.000Z",
        recoveryPolicy: "create_recovery_issue",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "timeout_exceeded",
    });

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, issueId))
      .then((rows) => rows.find((row) => row.companyId === companyId && row.originKind === "stranded_issue_recovery") ?? null);
    expect(recoveryIssue).toMatchObject({
      parentId: issueId,
      priority: "high",
      assigneeAdapterOverrides: null,
    });
    expect(["todo", "in_progress"]).toContain(recoveryIssue?.status);
  });

  it("omits external monitor refs from wake payloads and activity details", async () => {
    const { issueId, agentId } = await seedFixture({
      monitor: {
        serviceName: "Deploy provider",
        externalRef: "https://provider.example/deploy/123?token=secret",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    await heartbeat.tickTimers(tickAt);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(JSON.stringify(wakeup?.payload)).not.toContain("provider.example");
    expect(wakeup?.payload).not.toHaveProperty("externalRef");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(JSON.stringify(activity.map((row) => row.details))).not.toContain("provider.example");
    expect(activity.find((row) => row.action === "issue.monitor_triggered")?.details).not.toHaveProperty("externalRef");
  });
});

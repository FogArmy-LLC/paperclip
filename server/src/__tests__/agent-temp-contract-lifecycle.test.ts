import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";
import {
  evaluateTempContractExpiry,
  readTempContractLease,
} from "../services/temp-contract-reaper.js";

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(),
  createAgentRegistry: vi.fn(),
  createRuntimeStore: vi.fn(),
  isAcpRuntimeError: vi.fn(() => false),
}));

const companyId = "22222222-2222-4222-8222-222222222222";
const ceoId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const podLeadId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const deepWorkerId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const coreBuilderId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const tempBuilderId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function makeAgent(overrides: Record<string, unknown>) {
  return {
    id: coreBuilderId,
    companyId,
    name: "Agent",
    urlKey: "agent",
    role: "engineer",
    title: "Agent",
    icon: null,
    status: "idle",
    reportsTo: podLeadId,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-11-16T00:00:00.000Z"),
    updatedAt: new Date("2026-11-16T00:00:00.000Z"),
    ...overrides,
  };
}

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  getConfigRevision: vi.fn(),
  listConfigRevisions: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  clearError: vi.fn(),
  activatePendingApproval: vi.fn(),
  terminate: vi.fn(),
  update: vi.fn(),
  rollbackConfigRevision: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockLifecycleService = vi.hoisted(() => ({
  requestHire: vi.fn(),
  pauseAgent: vi.fn(),
  resumeAgent: vi.fn(),
  terminateAgent: vi.fn(),
  retryLifecycle: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  findOpenHireApprovalForAgent: vi.fn(),
  approveHire: vi.fn(),
  rejectHire: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  cancelActiveForAgent: vi.fn(),
  cancelBudgetScopeWork: vi.fn(),
  cancelInvocationsForAgents: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../lib/agent-runner-platform.js", () => ({
    localAgentRunnerTarget: () => ({
      driver: "local",
      platform: "linux",
      architecture: "x64",
      libc: "glibc",
      glibcVersion: "2.39",
    }),
    localPaperclipRunnerSupported: () => true,
  }));
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentCreated: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: () => null,
  }));
  vi.doMock("../services/agent-lifecycle.js", () => ({
    createAgentLifecycle: () => mockLifecycleService,
  }));
  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));
  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));
  vi.doMock("../services/approvals.js", () => ({
    approvalService: () => mockApprovalService,
  }));
  vi.doMock("../services/company-skills.js", () => ({
    companySkillService: () => ({
      listRuntimeSkillEntries: vi.fn(async () => []),
      resolveRequestedSkillKeys: vi.fn(async () => []),
    }),
  }));
  vi.doMock("../services/budgets.js", () => ({
    budgetService: () => ({ upsertPolicy: vi.fn() }),
  }));
  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));
  vi.doMock("../services/issue-approvals.js", () => ({
    issueApprovalService: () => ({ linkManyForApproval: vi.fn() }),
  }));
  vi.doMock("../services/issues.js", () => ({
    issueService: () => ({ list: vi.fn() }),
  }));
  vi.doMock("../services/secrets.js", () => ({
    secretService: () => ({
      normalizeAdapterConfigForPersistence: vi.fn(async (_cid: string, cfg: unknown) => cfg ?? {}),
      resolveAdapterConfigForRuntime: vi.fn(),
    }),
  }));
  vi.doMock("../services/environments.js", () => ({
    environmentService: () => ({
      getById: vi.fn(),
      listBoundCompanyIds: vi.fn(async () => []),
    }),
  }));
  vi.doMock("../services/agent-instructions.js", () => ({
    agentInstructionsService: () => ({
      materializeManagedBundle: vi.fn(async (a: unknown) => a),
    }),
    agentInstructionsBundleMode: () => "managed",
    syncInstructionsBundleConfigFromFilePath: vi.fn((a: unknown) => a),
  }));
  vi.doMock("../services/workspace-operations.js", () => ({
    workspaceOperationService: () => ({}),
  }));
  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));
  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => ({
      get: vi.fn(),
      getGeneral: vi.fn(),
      getExperimental: vi.fn(),
    }),
  }));
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({ materializeManagedBundle: vi.fn(async (a: unknown) => a) }),
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
    companySkillService: () => ({
      listRuntimeSkillEntries: vi.fn(async () => []),
      resolveRequestedSkillKeys: vi.fn(async () => []),
    }),
    budgetService: () => ({ upsertPolicy: vi.fn() }),
    heartbeatService: () => mockHeartbeatService,
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    issueApprovalService: () => ({ linkManyForApproval: vi.fn() }),
    issueService: () => ({ list: vi.fn() }),
    logActivity: mockLogActivity,
    secretService: () => ({
      normalizeAdapterConfigForPersistence: vi.fn(async (_cid: string, cfg: unknown) => cfg ?? {}),
      resolveAdapterConfigForRuntime: vi.fn(),
    }),
    syncInstructionsBundleConfigFromFilePath: vi.fn((a: unknown) => a),
    workspaceOperationService: () => ({}),
    environmentService: () => ({ getById: vi.fn(), listBoundCompanyIds: vi.fn(async () => []) }),
  }));
}

function createDbStub(requireBoardApprovalForNewAgents = true) {
  const rows = [
    {
      id: companyId,
      name: "FogArmy Test Co",
      requireBoardApprovalForNewAgents,
    },
  ];
  const whereResult: any = Promise.resolve([]);
  whereResult.then = (onFulfilled: any, onRejected: any) =>
    Promise.resolve(rows).then(onFulfilled, onRejected);
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(whereResult),
      }),
    }),
  };
}

describe("temp contract lease evaluation", () => {
  it("parses valid temp contract leases and ignores core or empty configs", () => {
    expect(readTempContractLease({})).toBeNull();
    expect(readTempContractLease({ contractLease: { kind: "core" } })).toBeNull();

    const parsed = readTempContractLease({
      contractLease: {
        kind: "temp",
        reason: "provider_failover",
        hiredByAgentId: podLeadId,
        boundIssueId: "99999999-9999-4999-8999-999999999999",
        ttlMinutes: 90,
        maxIdleMinutes: 20,
      },
    });
    expect(parsed).toMatchObject({
      kind: "temp",
      reason: "provider_failover",
      hiredByAgentId: podLeadId,
      ttlMinutes: 90,
      maxIdleMinutes: 20,
    });
  });

  it("triggers expiry on bound issue closure, TTL deadline, and maxIdleMinutes", () => {
    const createdAt = new Date("2026-11-16T10:00:00.000Z");
    const lease = readTempContractLease({
      contractLease: {
        kind: "temp",
        reason: "sla_surge",
        boundIssueId: "99999999-9999-4999-8999-999999999999",
        leasedAt: "2026-11-16T10:00:00.000Z",
        expiresAt: "2026-11-16T12:00:00.000Z",
        ttlMinutes: 120,
        maxIdleMinutes: 30,
      },
    })!;

    expect(
      evaluateTempContractExpiry({
        lease,
        createdAt,
        lastHeartbeatAt: new Date("2026-11-16T10:10:00.000Z"),
        boundIssueStatus: "in_progress",
        now: new Date("2026-11-16T10:25:00.000Z"),
      }),
    ).toBeNull();

    expect(
      evaluateTempContractExpiry({
        lease,
        createdAt,
        lastHeartbeatAt: new Date("2026-11-16T10:10:00.000Z"),
        boundIssueStatus: "done",
        now: new Date("2026-11-16T10:15:00.000Z"),
      }),
    ).toBe("bound_issue_closed");

    expect(
      evaluateTempContractExpiry({
        lease,
        createdAt,
        lastHeartbeatAt: new Date("2026-11-16T10:10:00.000Z"),
        boundIssueStatus: "in_progress",
        now: new Date("2026-11-16T10:41:00.000Z"),
      }),
    ).toBe("idle_exceeded");

    expect(
      evaluateTempContractExpiry({
        lease,
        createdAt,
        lastHeartbeatAt: new Date("2026-11-16T11:55:00.000Z"),
        boundIssueStatus: "in_progress",
        now: new Date("2026-11-16T12:00:01.000Z"),
      }),
    ).toBe("ttl_expired");
  });
});

describe("authoritative agent temp-contract lifecycle routes", () => {
  const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
    const [{ errorHandler }, { agentRoutes }] = await Promise.all([
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
      vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    ]);
    return { errorHandler, agentRoutes };
  });

  function createApp(actor: Record<string, unknown>, requireBoardApproval = true) {
    const { errorHandler, agentRoutes } = routeModules.value;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", agentRoutes(createDbStub(requireBoardApproval) as any));
    app.use(errorHandler);
    return app;
  }

  const ceoAgent = makeAgent({
    id: ceoId,
    name: "CEO",
    role: "ceo",
    reportsTo: null,
    permissions: { canCreateAgents: true },
  });
  const podLeadAgent = makeAgent({
    id: podLeadId,
    name: "Cartographer Lead",
    role: "engineer",
    reportsTo: ceoId,
    permissions: { canCreateAgents: true },
  });
  const deepWorkerAgent = makeAgent({
    id: deepWorkerId,
    name: "Depth-3 Worker",
    role: "engineer",
    reportsTo: podLeadId,
    permissions: { canCreateAgents: true },
  });
  const coreBuilder = makeAgent({
    id: coreBuilderId,
    name: "Core Builder",
    reportsTo: podLeadId,
    runtimeConfig: {},
  });
  const tempBuilder = makeAgent({
    id: tempBuilderId,
    name: "Temp Surge Builder",
    reportsTo: podLeadId,
    runtimeConfig: {
      contractLease: {
        kind: "temp",
        reason: "sla_surge",
        hiredByAgentId: podLeadId,
        ttlMinutes: 60,
        maxIdleMinutes: 20,
      },
    },
  });

  beforeEach(() => {
    vi.resetAllMocks();
    const directory = new Map([
      [ceoId, ceoAgent],
      [podLeadId, podLeadAgent],
      [deepWorkerId, deepWorkerAgent],
      [coreBuilderId, coreBuilder],
      [tempBuilderId, tempBuilder],
    ]);
    mockAgentService.getById.mockImplementation(async (id: string) => directory.get(id) ?? null);
    mockHeartbeatService.cancelInvocationsForAgents.mockResolvedValue({
      agentIds: [tempBuilderId],
      runsCancelled: 0,
      wakeupsCancelled: 0,
    });
    mockHeartbeatService.cancelActiveForAgent.mockResolvedValue(undefined);
  });

  it("allows hiring pod lead and CEO to release (terminate) a temp contractor, but forbids terminating core seats", async () => {
    mockLifecycleService.terminateAgent.mockResolvedValue({
      ...tempBuilder,
      status: "terminated",
    });

    const leadApp = createApp({
      type: "agent",
      agentId: podLeadId,
      companyId,
      companyIds: [companyId],
    });

    // Core seat -> 403 Forbidden even for hiring lead
    const coreRes = await request(leadApp).post(`/api/agents/${coreBuilderId}/terminate`).send({});
    expect(coreRes.status).toBe(403);
    expect(mockLifecycleService.terminateAgent).not.toHaveBeenCalled();

    // Temp contractor -> 200 OK for hiring lead
    const tempRes = await request(leadApp).post(`/api/agents/${tempBuilderId}/terminate`).send({});
    expect(tempRes.status).toBe(200);
    expect(tempRes.body.status).toBe("terminated");
    expect(mockLifecycleService.terminateAgent).toHaveBeenCalledWith(tempBuilderId);

    // Self-termination by the temp contractor itself -> 403
    const selfApp = createApp({
      type: "agent",
      agentId: tempBuilderId,
      companyId,
      companyIds: [companyId],
    });
    const selfRes = await request(selfApp).post(`/api/agents/${tempBuilderId}/terminate`).send({});
    expect(selfRes.status).toBe(403);
  });

  it("allows authoritative hiring lead to approve a pending_approval temp hire, while blocking core hire approval by agents", async () => {
    const pendingTemp = { ...tempBuilder, status: "pending_approval" };
    const pendingCore = { ...coreBuilder, status: "pending_approval" };
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === tempBuilderId) return pendingTemp;
      if (id === coreBuilderId) return pendingCore;
      if (id === podLeadId) return podLeadAgent;
      if (id === ceoId) return ceoAgent;
      return null;
    });
    mockApprovalService.approveHire.mockResolvedValue({
      applied: true,
      agent: { ...pendingTemp, status: "idle" },
      approval: { id: "app-1" },
    });

    const leadApp = createApp({
      type: "agent",
      agentId: podLeadId,
      companyId,
      companyIds: [companyId],
    });

    const coreApprove = await request(leadApp).post(`/api/agents/${coreBuilderId}/approve`).send({});
    expect(coreApprove.status).toBe(403);

    const tempApprove = await request(leadApp).post(`/api/agents/${tempBuilderId}/approve`).send({});
    expect(tempApprove.status).toBe(200);
    expect(tempApprove.body.status).toBe("idle");
    expect(mockApprovalService.approveHire).toHaveBeenCalledWith(tempBuilderId, podLeadId);
  });

  it("allows direct manager or CEO to clear transient provider errors on managed seats", async () => {
    mockAgentService.clearError.mockResolvedValue({ ...coreBuilder, status: "idle" });

    const leadApp = createApp({
      type: "agent",
      agentId: podLeadId,
      companyId,
      companyIds: [companyId],
    });
    const res = await request(leadApp).post(`/api/agents/${coreBuilderId}/clear-error`).send({});
    expect(res.status).toBe(200);
    expect(mockAgentService.clearError).toHaveBeenCalledWith(coreBuilderId);

    // Unrelated peer cannot clear error
    const peerApp = createApp({
      type: "agent",
      agentId: tempBuilderId,
      companyId,
      companyIds: [companyId],
    });
    const peerRes = await request(peerApp).post(`/api/agents/${coreBuilderId}/clear-error`).send({});
    expect(peerRes.status).toBe(403);
  });

  it("rejects temp contractor hires from depth >= 3 middle-tier workers to prevent org bloat", async () => {
    mockAccessService.decide.mockResolvedValue({ allowed: true, explanation: "ok" });

    const deepApp = createApp({
      type: "agent",
      agentId: deepWorkerId,
      companyId,
      companyIds: [companyId],
    });
    const res = await request(deepApp)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "Illegal Sub-Temp",
        role: "engineer",
        adapterType: "process",
        runtimeConfig: {
          contractLease: {
            kind: "temp",
            reason: "sla_surge",
            ttlMinutes: 60,
          },
        },
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/depth <= 2/i);
  });
});

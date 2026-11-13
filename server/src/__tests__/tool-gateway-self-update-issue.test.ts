import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  connectionGrants,
  createDb,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  issueComments,
  issues,
  startEmbeddedPostgresTestDatabase,
  toolApplications,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolConnections,
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import { mcpGatewayProtocolRoutes } from "../routes/tool-gateway.js";
import { buildPaperclipRuntimeMcpServers } from "../services/heartbeat.js";
import {
  createToolGatewayService,
  ToolGatewayHttpError,
} from "../services/tool-gateway.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("paperclip-self:update_issue MCP tool", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const originalApiUrl = process.env.PAPERCLIP_API_URL;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-self-update-issue-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    if (originalApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = originalApiUrl;
    await tempDb?.cleanup();
  });

  async function seedCompanyFixture(prefixBase: string) {
    const issuePrefix = `${prefixBase}${randomUUID().replaceAll("-", "").slice(0, 3).toUpperCase()}`;
    const [company] = await db
      .insert(companies)
      .values({
        name: `Company ${issuePrefix}`,
        issuePrefix,
        issueCounter: 2,
      })
      .returning();
    const [primaryAgent, peerAgent] = await db
      .insert(agents)
      .values([
        {
          companyId: company!.id,
          name: `Agent Primary ${issuePrefix}`,
          role: "engineer",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        {
          companyId: company!.id,
          name: `Agent Peer ${issuePrefix}`,
          role: "qa",
          adapterType: "claude_local",
          adapterConfig: {},
        },
      ])
      .returning();
    const [issueOne, issueTwo] = await db
      .insert(issues)
      .values([
        {
          companyId: company!.id,
          title: `Primary task ${issuePrefix}`,
          description: "Initial description",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: primaryAgent!.id,
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        },
        {
          companyId: company!.id,
          title: `Secondary task ${issuePrefix}`,
          description: "Secondary description",
          status: "todo",
          priority: "high",
          assigneeAgentId: null,
          issueNumber: 2,
          identifier: `${issuePrefix}-2`,
        },
      ])
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company!.id,
        agentId: primaryAgent!.id,
        status: "running",
        contextSnapshot: { issueId: issueOne!.id },
      })
      .returning();

    return {
      company: company!,
      issuePrefix,
      primaryAgent: primaryAgent!,
      peerAgent: peerAgent!,
      issueOne: issueOne!,
      issueTwo: issueTwo!,
      run: run!,
    };
  }

  it("allows paperclip-self:update_issue in the same self-MCP profile as get_issue_context without blocking on generic write require_approval, updating status, assignee, and comment by UUID or identifier", async () => {
    const f = await seedCompanyFixture("FAS");
    const gateway = createToolGatewayService(db);
    const app = express().use(express.json()).use(mcpGatewayProtocolRoutes(gateway));

    // Add a generic company-wide write approval rule to verify normal status/comment
    // handback on paperclip-self:update_issue is never blocked by require_approval.
    await db.insert(toolPolicies).values({
      companyId: f.company.id,
      name: "Generic write approval",
      policyType: "require_approval",
      priority: 1,
      enabled: true,
      selectors: {},
      conditions: { risk: { isWrite: true } },
    });

    // Self-MCP profile that explicitly grants get_issue_context + list_my_issues (the legacy read-only profile).
    const [selfProfile] = await db
      .insert(toolProfiles)
      .values({
        companyId: f.company.id,
        profileKey: `self-mcp:${randomUUID()}`,
        name: "Paperclip Self MCP",
        defaultAction: "deny",
        status: "active",
      })
      .returning();
    await db.insert(toolProfileEntries).values([
      {
        companyId: f.company.id,
        profileId: selfProfile!.id,
        selectorType: "tool_name",
        effect: "include",
        toolName: "paperclip-self:list_my_issues",
      },
      {
        companyId: f.company.id,
        profileId: selfProfile!.id,
        selectorType: "tool_name",
        effect: "include",
        toolName: "paperclip-self:get_issue_context",
      },
    ]);

    const namedGateway = await gateway.createNamedGateway({
      companyId: f.company.id,
      body: {
        name: "Agent self MCP gateway",
        slug: `self-gw-${randomUUID().slice(0, 8)}`,
        profileId: selfProfile!.id,
        defaultProfileMode: "gateway_only",
        agentId: f.primaryAgent.id,
        contextScopeType: "agent",
        contextScopeId: f.primaryAgent.id,
      },
      actor: { agentId: f.primaryAgent.id },
    });
    const mintedToken = await gateway.createNamedGatewayToken({
      companyId: f.company.id,
      gatewayId: namedGateway.id,
      body: {
        name: "Agent run token",
        subjectType: "heartbeat_run",
        subjectId: f.run.id,
        clientLabel: "claude_local",
        ownerNote: "Test self-MCP token",
        allowedActions: ["tools/list", "tools/call"],
      },
      actor: { agentId: f.primaryAgent.id },
    });

    const endpoint = `/mcp/gateways/${namedGateway.gatewayPublicId}`;
    const listRes = await request(app)
      .post(endpoint)
      .set("Authorization", `Bearer ${mintedToken.token}`)
      .send({ jsonrpc: "2.0", id: "list-1", method: "tools/list" })
      .expect(200);

    const tools = listRes.body.result.tools as Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>;
    const updateTool = tools.find(
      (entry) => entry.name === "paperclip-self:update_issue",
    );
    expect(updateTool).toBeDefined();
    expect(updateTool?.description).not.toContain("Requires approval");

    // 1. Update by identifier (e.g. FASxxx-1): hand back to in_review + reassign + post markdown comment.
    const handbackComment = "## Ready for review\n- Verified unit tests pass.";
    const callByIdentifier = await request(app)
      .post(endpoint)
      .set("Authorization", `Bearer ${mintedToken.token}`)
      .send({
        jsonrpc: "2.0",
        id: "call-1",
        method: "tools/call",
        params: {
          name: "paperclip-self:update_issue",
          arguments: {
            issueId: f.issueOne.identifier!.toLowerCase(),
            status: "in_review",
            assigneeAgentId: f.peerAgent.id,
            comment: handbackComment,
          },
        },
      })
      .expect(200);

    expect(callByIdentifier.body.result.isError).toBe(false);
    const structured = callByIdentifier.body.result.structuredContent as {
      ok: boolean;
      issueId: string;
      identifier: string;
      status: string;
      assigneeAgentId: string | null;
      commentId: string | null;
    };
    expect(structured).toEqual({
      ok: true,
      issueId: f.issueOne.id,
      identifier: f.issueOne.identifier,
      status: "in_review",
      assigneeAgentId: f.peerAgent.id,
      commentId: expect.any(String),
    });
    expect(JSON.parse(callByIdentifier.body.result.content[0].text)).toEqual(
      structured,
    );

    const [reloadedIssueOne] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, f.issueOne.id));
    expect(reloadedIssueOne?.status).toBe("in_review");
    expect(reloadedIssueOne?.assigneeAgentId).toBe(f.peerAgent.id);

    const [persistedComment] = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.id, structured.commentId!),
          eq(issueComments.companyId, f.company.id),
        ),
      );
    expect(persistedComment).toMatchObject({
      issueId: f.issueOne.id,
      companyId: f.company.id,
      authorAgentId: f.primaryAgent.id,
      authorType: "agent",
      body: handbackComment,
    });

    // 2. Update by UUID: unassign (assigneeAgentId: null) and transition to blocked without comment.
    const callByUuid = await request(app)
      .post(endpoint)
      .set("Authorization", `Bearer ${mintedToken.token}`)
      .send({
        jsonrpc: "2.0",
        id: "call-2",
        method: "tools/call",
        params: {
          name: "paperclip-self:update_issue",
          arguments: {
            issueId: f.issueTwo.id,
            status: "blocked",
            assigneeAgentId: null,
          },
        },
      })
      .expect(200);

    expect(callByUuid.body.result.structuredContent).toEqual({
      ok: true,
      issueId: f.issueTwo.id,
      identifier: f.issueTwo.identifier,
      status: "blocked",
      assigneeAgentId: null,
      commentId: null,
    });
  });

  it("also allows paperclip-self:update_issue on read-risk self profiles and through claude_local paperclip-assigned runtime gateways", async () => {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    const f = await seedCompanyFixture("CLD");
    const gateway = createToolGatewayService(db);
    const app = express().use(express.json()).use(mcpGatewayProtocolRoutes(gateway));

    // Give the agent a read-risk profile (the read-only self-MCP pattern) plus an installed MCP connection
    // so buildPaperclipRuntimeMcpServers provisions paperclip-assigned.
    const [application] = await db
      .insert(toolApplications)
      .values({
        companyId: f.company.id,
        applicationKey: `fixture-${randomUUID().slice(0, 8)}`,
        name: "Fixture Remote MCP",
        type: "mcp_http",
        status: "active",
      })
      .returning();
    const [connection] = await db
      .insert(toolConnections)
      .values({
        companyId: f.company.id,
        applicationId: application!.id,
        name: "Fixture Connection",
        uid: `conn/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        config: { url: "https://fixture.example.test/mcp" },
      })
      .returning();
    await db.insert(connectionGrants).values({
      companyId: f.company.id,
      connectionId: connection!.id,
      kind: "organization",
      status: "active",
      isDefault: true,
    });
    await db.insert(toolCatalogEntries).values({
      companyId: f.company.id,
      applicationId: application!.id,
      connectionId: connection!.id,
      name: "ping",
      toolName: "ping",
      riskLevel: "read",
      versionHash: "v1",
      status: "active",
    });
    await db.insert(toolConnectionInstalls).values({
      companyId: f.company.id,
      connectionId: connection!.id,
      targetType: "agent",
      targetId: f.primaryAgent.id,
    });

    const [agentProfile] = await db
      .insert(toolProfiles)
      .values({
        companyId: f.company.id,
        profileKey: `agent-self-read:${randomUUID()}`,
        name: "Agent Read + Self",
        defaultAction: "deny",
        status: "active",
      })
      .returning();
    await db.insert(toolProfileEntries).values([
      {
        companyId: f.company.id,
        profileId: agentProfile!.id,
        selectorType: "connection",
        effect: "include",
        applicationId: application!.id,
        connectionId: connection!.id,
      },
      {
        companyId: f.company.id,
        profileId: agentProfile!.id,
        selectorType: "risk_level",
        effect: "include",
        riskLevel: "read",
      },
    ]);
    await db.insert(toolProfileBindings).values({
      companyId: f.company.id,
      profileId: agentProfile!.id,
      targetType: "agent",
      targetId: f.primaryAgent.id,
    });

    const runtimeServers = await buildPaperclipRuntimeMcpServers({
      db,
      agent: f.primaryAgent,
      runId: f.run.id,
    });
    expect(runtimeServers).toHaveLength(1);
    expect(runtimeServers[0]?.name).toBe("paperclip-assigned");

    const assignedEndpoint = new URL(runtimeServers[0]!.url).pathname;
    const listed = await request(app)
      .post(assignedEndpoint)
      .set("Authorization", `Bearer ${runtimeServers[0]!.token}`)
      .send({ jsonrpc: "2.0", id: "assigned-list", method: "tools/list" })
      .expect(200);
    const listedNames = (listed.body.result.tools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    expect(listedNames).toContain("paperclip-self:get_issue_context");
    expect(listedNames).toContain("paperclip-self:update_issue");

    const updated = await request(app)
      .post(assignedEndpoint)
      .set("Authorization", `Bearer ${runtimeServers[0]!.token}`)
      .send({
        jsonrpc: "2.0",
        id: "assigned-call",
        method: "tools/call",
        params: {
          name: "paperclip-self:update_issue",
          arguments: {
            issueId: f.issueOne.identifier,
            status: "done",
            comment: "Completed via paperclip-assigned MCP.",
          },
        },
      })
      .expect(200);

    expect(updated.body.result.structuredContent).toEqual({
      ok: true,
      issueId: f.issueOne.id,
      identifier: f.issueOne.identifier,
      status: "done",
      assigneeAgentId: f.primaryAgent.id,
      commentId: expect.any(String),
    });
  });

  it("enforces strict company boundaries and rejects cross-company issueId or cross-company assigneeAgentId with 403", async () => {
    const companyA = await seedCompanyFixture("CPA");
    const companyB = await seedCompanyFixture("HUM");
    const gateway = createToolGatewayService(db);
    const app = express().use(express.json()).use(mcpGatewayProtocolRoutes(gateway));

    const [profileA] = await db
      .insert(toolProfiles)
      .values({
        companyId: companyA.company.id,
        profileKey: `company-a-self:${randomUUID()}`,
        name: "Company A Self Profile",
        defaultAction: "allow",
        status: "active",
      })
      .returning();
    await db.insert(toolProfileBindings).values({
      companyId: companyA.company.id,
      profileId: profileA!.id,
      targetType: "agent",
      targetId: companyA.primaryAgent.id,
    });

    const sessionA = await gateway.createSession({
      companyId: companyA.company.id,
      agentId: companyA.primaryAgent.id,
      runId: companyA.run.id,
      issueId: companyA.issueOne.id,
    });

    // Cross-company issueId by UUID must fail closed with 403
    await expect(
      gateway.executeTool({
        sessionToken: sessionA.token,
        tool: "paperclip-self:update_issue",
        parameters: {
          issueId: companyB.issueOne.id,
          status: "done",
          comment: "Cross-tenant write attempt by UUID",
        },
      }),
    ).rejects.toMatchObject({
      status: 403,
      reasonCode: "company_boundary_violation",
    } satisfies Partial<ToolGatewayHttpError>);

    // Cross-company issueId by identifier (e.g. HUMxxx-1) over MCP HTTP must also fail closed with 403
    const namedGatewayA = await gateway.createNamedGateway({
      companyId: companyA.company.id,
      body: {
        name: "Company A Gateway",
        slug: `cpa-gw-${randomUUID().slice(0, 8)}`,
        profileId: profileA!.id,
        defaultProfileMode: "gateway_only",
        agentId: companyA.primaryAgent.id,
      },
      actor: { agentId: companyA.primaryAgent.id },
    });
    const tokenA = await gateway.createNamedGatewayToken({
      companyId: companyA.company.id,
      gatewayId: namedGatewayA.id,
      body: {
        name: "Company A Token",
        subjectType: "heartbeat_run",
        subjectId: companyA.run.id,
        clientLabel: "claude_local",
        ownerNote: "",
        allowedActions: ["tools/list", "tools/call"],
      },
      actor: { agentId: companyA.primaryAgent.id },
    });

    const crossCompanyHttpRes = await request(app)
      .post(`/mcp/gateways/${namedGatewayA.gatewayPublicId}`)
      .set("Authorization", `Bearer ${tokenA.token}`)
      .send({
        jsonrpc: "2.0",
        id: "cross-identifier",
        method: "tools/call",
        params: {
          name: "paperclip-self:update_issue",
          arguments: {
            issueId: companyB.issueOne.identifier,
            status: "done",
            comment: "Cross-tenant write attempt by identifier",
          },
        },
      })
      .expect(403);
    expect(crossCompanyHttpRes.body.error.data.reasonCode).toBe(
      "company_boundary_violation",
    );

    // Cross-company assigneeAgentId on a same-company issue must also fail closed with 403
    await expect(
      gateway.executeTool({
        sessionToken: sessionA.token,
        tool: "paperclip-self:update_issue",
        parameters: {
          issueId: companyA.issueOne.id,
          assigneeAgentId: companyB.primaryAgent.id,
        },
      }),
    ).rejects.toMatchObject({
      status: 403,
      reasonCode: "company_boundary_violation",
    } satisfies Partial<ToolGatewayHttpError>);

    // Verify Company B's issue and comments were completely untouched
    const [reloadedCompanyBIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, companyB.issueOne.id));
    expect(reloadedCompanyBIssue?.status).toBe("in_progress");
    expect(reloadedCompanyBIssue?.assigneeAgentId).toBe(
      companyB.primaryAgent.id,
    );
    const companyBComments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, companyB.issueOne.id));
    expect(companyBComments).toHaveLength(0);
  });
});

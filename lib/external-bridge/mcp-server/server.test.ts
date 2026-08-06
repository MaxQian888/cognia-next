/**
 * Coverage for the MCP server skeleton — exercises tool registration +
 * the gate→handler→envelope dispatch using the SDK's in-memory transport.
 */

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createWikiArticle } from "@/lib/db/wiki-articles"
import { createCharacter } from "@/lib/db/characters"
import { listMcpAuditLog } from "@/lib/db/mcp-audit-log"
import type { ExternalBridgeSettings } from "@/types/wiki"
import type { WorkflowMcpDeploymentDescriptor, WorkflowMcpHost } from "../handlers/workflow"
import { buildMcpServer, startWorkflowToolRefresh, __TESTING__ } from "./server"

function settings(overrides: Partial<ExternalBridgeSettings> = {}): ExternalBridgeSettings {
  return {
    enabled: overrides.enabled ?? true,
    enabledScopes: overrides.enabledScopes ?? ["wiki:cognia", "rag:cognia"],
    bearerToken: overrides.bearerToken,
    httpPort: overrides.httpPort,
    tokenRotatedAt: overrides.tokenRotatedAt,
  }
}

async function makeWiredPair(currentSettings: ExternalBridgeSettings | undefined) {
  const server = buildMcpServer({ settingsGetter: async () => currentSettings })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(clientTransport)
  return { server, client }
}

function workflowDescriptor(
  overrides: Partial<WorkflowMcpDeploymentDescriptor> = {}
): WorkflowMcpDeploymentDescriptor {
  return {
    deploymentId: "deployment-1",
    workflowId: "workflow-1",
    versionId: "version-1",
    revision: 1,
    environment: "production",
    name: "Summarize PRs",
    toolName: "workflow_summarize_prs",
    inputSchema: {
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
    },
    ...overrides,
  }
}

function workflowHost(
  descriptors: WorkflowMcpDeploymentDescriptor[]
): jest.Mocked<WorkflowMcpHost> {
  return {
    listDeployments: jest.fn(async () => descriptors),
    createRun: jest.fn(
      async (
        _input: Parameters<WorkflowMcpHost["createRun"]>[0]
      ): Promise<Awaited<ReturnType<WorkflowMcpHost["createRun"]>>> => ({
        runId: "run-1",
        status: "pending",
      })
    ),
    getRun: jest.fn(
      async ({
        runId,
      }: Parameters<WorkflowMcpHost["getRun"]>[0]): Promise<
        Awaited<ReturnType<WorkflowMcpHost["getRun"]>>
      > => ({
        runId,
        workflowId: "workflow-1",
        status: "running",
        startedAt: 1,
      })
    ),
    listEvents: jest.fn(
      async (
        _input: Parameters<WorkflowMcpHost["listEvents"]>[0]
      ): Promise<Awaited<ReturnType<WorkflowMcpHost["listEvents"]>>> => ({
        events: [],
        terminal: false,
      })
    ),
    cancelRun: jest.fn(
      async ({
        runId,
      }: Parameters<WorkflowMcpHost["cancelRun"]>[0]): Promise<
        Awaited<ReturnType<WorkflowMcpHost["cancelRun"]>>
      > => ({ runId, cancelled: true, mode: "cooperative" })
    ),
  }
}

async function makeWorkflowWiredPair(
  currentSettings: ExternalBridgeSettings,
  host: WorkflowMcpHost
) {
  const opts = { settingsGetter: async () => currentSettings, workflowHost: host }
  const server = buildMcpServer(opts)
  const refresh = await startWorkflowToolRefresh(server, {
    ...opts,
    refreshIntervalMs: 0,
  })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "workflow-test-client", version: "0.0.1" })
  await client.connect(clientTransport)
  return { server, client, refresh }
}

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
}, 30_000)

afterAll(dbFixture.dispose)

describe("buildMcpServer — tool registration", () => {
  // Note: `client.listTools()` round-trips through zod-to-json-schema which
  // hits a known compat issue with @modelcontextprotocol/sdk 1.29 +
  // zod 4.3 (`_zod undefined`). We instead verify each tool is callable —
  // an unknown tool would raise a different error, so a successful (or
  // gated) callTool proves the tool is registered.
  it.each(["wiki_search", "wiki_read", "rag_search", "runtime_query"])(
    "registers %s and accepts a call",
    async (toolName) => {
      const { client } = await makeWiredPair(
        settings({
          enabledScopes: ["wiki:cognia", "rag:cognia", "runtime:skills"],
        })
      )
      const args =
        toolName === "wiki_search"
          ? { query: "" }
          : toolName === "wiki_read"
            ? { slug: "anything" }
            : toolName === "rag_search"
              ? { query: "anything" }
              : { entityType: "skill", op: "list" }
      const result = await client.callTool({ name: toolName, arguments: args })
      expect(result).toBeDefined()
      expect(Array.isArray((result as { content?: unknown[] }).content)).toBe(true)
      await client.close()
    }
  )
})

describe("buildMcpServer — per-client scope projection", () => {
  it("intersects host scopes with server-stamped client scopes", async () => {
    const { client } = await makeWiredPair(
      settings({ enabledScopes: ["wiki:cognia", "memory:write"] })
    )
    const denied = await client.callTool({
      name: "memory_store",
      arguments: { text: "must not be written" },
      _meta: { cogniaBridgeScopes: ["wiki:cognia"] },
    })

    expect(denied.isError).toBe(true)
    await client.close()
  })

  it("never lets client scopes expand the host allowlist", async () => {
    const { client } = await makeWiredPair(settings({ enabledScopes: ["wiki:cognia"] }))
    const denied = await client.callTool({
      name: "memory_store",
      arguments: { text: "must not be written" },
      _meta: { cogniaBridgeScopes: ["memory:write"] },
    })

    expect(denied.isError).toBe(true)
    await client.close()
  })

  it.each([
    ["schedule_task", { sessionId: "s1", prompt: "hi", intervalMs: 60_000 }],
    ["list_scheduled_tasks", { sessionId: "s1" }],
    ["cancel_scheduled_task", { sessionId: "s1", taskId: "t1" }],
  ])("applies the client scope projection to %s", async (toolName, args) => {
    const { client } = await makeWiredPair(
      settings({ enabledScopes: ["agent:dispatch", "wiki:cognia"] })
    )
    const denied = await client.callTool({
      name: toolName,
      arguments: args,
      _meta: { cogniaBridgeScopes: ["wiki:cognia"] },
    })

    expect(denied.isError).toBe(true)
    await client.close()
  })
})

describe("buildMcpServer — orchestration tools (Thread D)", () => {
  it.each([
    ["agent_dispatch", { subagentId: "x", prompt: "hi" }],
    [
      "spawn_task",
      {
        parentSessionId: "s1",
        title: "Fix cleanup",
        tldr: "Handle it separately.",
        situation: "Cleanup is missing.",
        code_locations: [],
        solution: "Add cleanup.",
        caveats: [],
      },
    ],
    ["team_run", { teamId: "t1" }],
    ["team_list", {}],
    ["plugin_tool_invoke", { pluginId: "p", toolName: "t" }],
    ["schedule_task", { sessionId: "s1", prompt: "hi", intervalMs: 60_000 }],
    ["list_scheduled_tasks", { sessionId: "s1" }],
    ["cancel_scheduled_task", { sessionId: "s1", taskId: "t1" }],
  ])("registers %s and denies it when the scope is OFF", async (toolName, args) => {
    const { client } = await makeWiredPair(settings({ enabledScopes: [] }))
    const result = await client.callTool({ name: toolName, arguments: args })
    expect(result.isError).toBe(true)
    await client.close()
  })

  it("allows team_list when the agent:team scope is ON", async () => {
    const { client } = await makeWiredPair(settings({ enabledScopes: ["agent:team"] }))
    const result = await client.callTool({ name: "team_list", arguments: {} })
    // Gate passed → handler ran (non-Tauri env returns the structured
    // "requires desktop renderer" payload, not a gate error).
    expect(result.isError).not.toBe(true)
    await client.close()
  })

  it("allows agent_dispatch when the agent:dispatch scope is ON", async () => {
    const { client } = await makeWiredPair(settings({ enabledScopes: ["agent:dispatch"] }))
    const result = await client.callTool({
      name: "agent_dispatch",
      arguments: { subagentId: "x", prompt: "hi" },
    })
    // Gate passed → handler ran. In the jest (non-Tauri) env the handler
    // returns the structured "requires desktop renderer" payload, but the
    // call itself is NOT a gate error.
    expect(result.isError).not.toBe(true)
    await client.close()
  })

  it("allows spawn_task when the agent:dispatch scope is ON", async () => {
    const { client } = await makeWiredPair(settings({ enabledScopes: ["agent:dispatch"] }))
    const result = await client.callTool({
      name: "spawn_task",
      arguments: {
        parentSessionId: "s1",
        title: "Fix cleanup",
        tldr: "Handle it separately.",
        situation: "Cleanup is missing.",
        code_locations: [],
        solution: "Add cleanup.",
        caveats: [],
      },
    })
    expect(result.isError).not.toBe(true)
    await client.close()
  })
})

describe("buildMcpServer — immutable workflow deployments", () => {
  it("routes lifecycle tools through the shared host adapter", async () => {
    const descriptor = workflowDescriptor()
    const host = workflowHost([descriptor])
    const { client, refresh } = await makeWorkflowWiredPair(
      settings({ enabledScopes: ["workflow:run"] }),
      host
    )

    const listed = await client.callTool({ name: "workflow_list", arguments: {} })
    expect(listed.structuredContent).toEqual({ deployments: [descriptor] })
    await client.callTool({ name: "workflow_status", arguments: { runId: "run-1" } })
    await client.callTool({
      name: "workflow_events",
      arguments: { runId: "run-1", afterSequence: 12, limit: 50 },
    })
    await client.callTool({
      name: "workflow_cancel",
      arguments: { runId: "run-1" },
      _meta: { cogniaBridgeClientId: "client-7" },
    })

    expect(host.getRun).toHaveBeenCalledWith({ runId: "run-1" })
    expect(host.listEvents).toHaveBeenCalledWith({
      runId: "run-1",
      afterSequence: 12,
      limit: 50,
    })
    expect(host.cancelRun).toHaveBeenCalledWith({ runId: "run-1", caller: "mcp:client-7" })
    refresh.stop()
    await client.close()
  })

  it("registers a typed deployment tool and stamps caller plus idempotency metadata", async () => {
    const host = workflowHost([workflowDescriptor()])
    const { client, refresh } = await makeWorkflowWiredPair(
      settings({ enabledScopes: ["workflow:run"] }),
      host
    )

    const invalid = await client.callTool({
      name: "workflow_summarize_prs",
      arguments: { topic: 42 },
    })
    expect(invalid).toMatchObject({ isError: true })
    expect(JSON.stringify(invalid.content)).toContain("Input validation error")
    const accepted = await client.callTool({
      name: "workflow_summarize_prs",
      arguments: { topic: "release" },
      _meta: {
        cogniaBridgeClientId: "client-9",
        cogniaIdempotencyKey: "call-42",
      },
    })

    expect(accepted.structuredContent).toEqual({ runId: "run-1", status: "pending" })
    expect(host.createRun).toHaveBeenCalledWith({
      deploymentId: "deployment-1",
      caller: "mcp:client-9",
      idempotencyKey: "call-42",
      input: { topic: "release" },
    })
    refresh.stop()
    await client.close()
  })

  it("applies the per-client scope projection to dynamic workflow tools", async () => {
    const host = workflowHost([workflowDescriptor()])
    const { client, refresh } = await makeWorkflowWiredPair(
      settings({ enabledScopes: ["workflow:run", "wiki:cognia"] }),
      host
    )

    const denied = await client.callTool({
      name: "workflow_summarize_prs",
      arguments: { topic: "release" },
      _meta: { cogniaBridgeScopes: ["wiki:cognia"] },
    })

    expect(denied.isError).toBe(true)
    expect(host.createRun).not.toHaveBeenCalled()
    refresh.stop()
    await client.close()
  })

  it("refreshes changed schemas and removes disabled deployment tools", async () => {
    let descriptors = [workflowDescriptor()]
    const host = workflowHost(descriptors)
    host.listDeployments.mockImplementation(async () => descriptors)
    const { server, client, refresh } = await makeWorkflowWiredPair(
      settings({ enabledScopes: ["workflow:run"] }),
      host
    )
    const notification = jest.spyOn(server, "sendToolListChanged")

    descriptors = [
      workflowDescriptor({
        versionId: "version-2",
        revision: 2,
        inputSchema: {
          type: "object",
          properties: { count: { type: "integer" } },
          required: ["count"],
        },
      }),
    ]
    notification.mockClear()
    await refresh.refresh()
    const staleSchema = await client.callTool({
      name: "workflow_summarize_prs",
      arguments: { topic: "old" },
    })
    expect(staleSchema).toMatchObject({ isError: true })
    expect(JSON.stringify(staleSchema.content)).toContain("Input validation error")
    await client.callTool({ name: "workflow_summarize_prs", arguments: { count: 2 } })
    expect(notification).toHaveBeenCalledTimes(1)

    descriptors = []
    await refresh.refresh()
    const removed = await client.callTool({
      name: "workflow_summarize_prs",
      arguments: { count: 2 },
    })
    expect(removed).toMatchObject({ isError: true })
    expect(JSON.stringify(removed.content)).toMatch(/not found/i)

    refresh.stop()
    await client.close()
  })

  it("retains the last known-good tools when a replacement registration fails", async () => {
    let descriptors = [workflowDescriptor()]
    const host = workflowHost(descriptors)
    host.listDeployments.mockImplementation(async () => descriptors)
    const { client, refresh } = await makeWorkflowWiredPair(
      settings({ enabledScopes: ["workflow:run"] }),
      host
    )

    descriptors = [
      workflowDescriptor({
        versionId: "version-2",
        revision: 2,
        toolName: "workflow_list",
      }),
    ]
    await expect(refresh.refresh()).rejects.toThrow(/workflow_list/i)

    const retained = await client.callTool({
      name: "workflow_summarize_prs",
      arguments: { topic: "release" },
    })
    expect(retained.structuredContent).toEqual({ runId: "run-1", status: "pending" })

    refresh.stop()
    await client.close()
  })
})

describe("buildMcpServer — memory tools (ADR-0069)", () => {
  it.each([
    ["memory_search", { query: "pnpm" }],
    ["memory_list", {}],
    ["memory_store", { text: "User prefers pnpm" }],
    ["memory_update", { id: "m1", importance: 5 }],
    ["memory_forget", { id: "m1" }],
  ])("registers %s and denies it when the scope is OFF", async (toolName, args) => {
    const { client } = await makeWiredPair(settings({ enabledScopes: [] }))
    const result = await client.callTool({ name: toolName, arguments: args })
    expect(result.isError).toBe(true)
    await client.close()
  })

  it("read scope does not grant writes (and vice versa)", async () => {
    const { client } = await makeWiredPair(settings({ enabledScopes: ["memory:read"] }))
    const denied = await client.callTool({
      name: "memory_store",
      arguments: { text: "User prefers pnpm" },
    })
    expect(denied.isError).toBe(true)
    const allowed = await client.callTool({ name: "memory_list", arguments: {} })
    expect(allowed.isError).not.toBe(true)
    await client.close()
  })

  it("stores and lists a memory end-to-end when both scopes are ON", async () => {
    const { client } = await makeWiredPair(
      settings({ enabledScopes: ["memory:read", "memory:write"] })
    )
    const stored = await client.callTool({
      name: "memory_store",
      arguments: { text: "User ships on Fridays", tags: ["habit"] },
    })
    expect(stored.isError).not.toBe(true)
    const storedPayload = stored.structuredContent as { ok: boolean; stored: boolean }
    expect(storedPayload.ok).toBe(true)
    expect(storedPayload.stored).toBe(true)

    const listed = await client.callTool({ name: "memory_list", arguments: {} })
    const listedPayload = listed.structuredContent as {
      ok: boolean
      memories: Array<{ text: string; provenance: string }>
    }
    expect(listedPayload.ok).toBe(true)
    expect(listedPayload.memories.some((m) => m.text === "User ships on Fridays")).toBe(true)
    expect(listedPayload.memories[0]?.provenance).toBe("external")
    await client.close()
  })

  it("blocks a PII store with a structured pii_blocked result", async () => {
    const { client } = await makeWiredPair(settings({ enabledScopes: ["memory:write"] }))
    const result = await client.callTool({
      name: "memory_store",
      arguments: { text: "reach me at bob@example.com" },
    })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({ ok: false, reason: "pii_blocked" })
    await client.close()
  })

  it("forwards namespace fields and pinned updates through the registered tools", async () => {
    const { client } = await makeWiredPair(
      settings({ enabledScopes: ["memory:read", "memory:write"] })
    )
    const stored = await client.callTool({
      name: "memory_store",
      arguments: {
        text: "Workspace uses pnpm",
        scope: "workspace",
        projectId: "project_1",
        branch: "main",
        pathPattern: "src",
      },
    })
    const memoryId = (stored.structuredContent as { memoryId?: string }).memoryId
    expect(memoryId).toBeTruthy()
    const updated = await client.callTool({
      name: "memory_update",
      arguments: { id: memoryId!, pinned: true },
    })
    expect(updated.isError).not.toBe(true)
    const listed = await client.callTool({
      name: "memory_list",
      arguments: {
        scope: "workspace",
        projectId: "project_1",
        branch: "main",
        pathPattern: "src",
      },
    })
    expect(
      (listed.structuredContent as { memories: Array<{ id: string; pinned: boolean }> }).memories
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: memoryId, pinned: true })]))
    await client.close()
  })
})

describe("buildMcpServer — wiki_search dispatch", () => {
  it("returns a structured result when the gate allows the call", async () => {
    await createWikiArticle({
      slug: "lib-foo",
      title: "lib/foo overview",
      module: "lib/foo",
      corpusId: "cognia-self",
      scope: "cognia-self",
      pageRank: 0.5,
      summary: "summary",
      sectionIds: [],
      sourceRefs: [],
      contentMd: "body",
      embedding: [],
      generatorVersion: "v1",
      fileHashes: {},
    })
    const { client } = await makeWiredPair(settings())
    const result = await client.callTool({
      name: "wiki_search",
      arguments: { query: "" },
    })
    expect(result.isError).not.toBe(true)
    const structured = (result as { structuredContent?: { results: { slug: string }[] } })
      .structuredContent
    expect(structured?.results.map((r) => r.slug)).toContain("lib-foo")
    await client.close()
  })

  it("returns an error envelope when the scope is OFF", async () => {
    const { client } = await makeWiredPair(settings({ enabledScopes: [] }))
    const result = await client.callTool({
      name: "wiki_search",
      arguments: { query: "anything" },
    })
    expect(result.isError).toBe(true)
    await client.close()
  })

  it("returns error envelope when settings is undefined (default deny)", async () => {
    const { client } = await makeWiredPair(undefined)
    const result = await client.callTool({
      name: "wiki_search",
      arguments: { query: "anything" },
    })
    expect(result.isError).toBe(true)
    await client.close()
  })
})

describe("buildMcpServer — wiki_read dispatch", () => {
  it("returns an error envelope when slug is unknown", async () => {
    const { client } = await makeWiredPair(settings())
    const result = await client.callTool({
      name: "wiki_read",
      arguments: { slug: "ghost-slug" },
    })
    const structured = (result as { structuredContent?: { error?: string } }).structuredContent
    expect(structured?.error).toMatch(/not found/)
    await client.close()
  })
})

describe("buildMcpServer — runtime_query gate", () => {
  it("denies runtime_query when the entity scope is OFF", async () => {
    const { client } = await makeWiredPair(settings({ enabledScopes: ["wiki:cognia"] }))
    const result = await client.callTool({
      name: "runtime_query",
      arguments: { entityType: "skill", op: "list" },
    })
    expect(result.isError).toBe(true)
    await client.close()
  })

  it("allows runtime_query when the matching scope is ON", async () => {
    const { client } = await makeWiredPair(settings({ enabledScopes: ["runtime:skills"] }))
    const result = await client.callTool({
      name: "runtime_query",
      arguments: { entityType: "skill", op: "list" },
    })
    expect(result.isError).not.toBe(true)
    await client.close()
  })
})

describe("audit log integration", () => {
  it("writes a row for every dispatched tool call", async () => {
    const { client } = await makeWiredPair(settings())
    await client.callTool({ name: "wiki_search", arguments: { query: "" } })
    await client.callTool({ name: "wiki_search", arguments: { query: "anything" } })
    const log = await listMcpAuditLog()
    expect(log.length).toBeGreaterThanOrEqual(2)
    const calls = log.filter((r) => r.tool === "wiki_search")
    expect(calls.length).toBeGreaterThanOrEqual(2)
    await client.close()
  })

  it("records denials with the deny reason", async () => {
    const { client } = await makeWiredPair(settings({ enabledScopes: [] }))
    await client.callTool({ name: "wiki_search", arguments: { query: "x" } })
    const log = await listMcpAuditLog({ deniedOnly: true })
    expect(log.length).toBeGreaterThanOrEqual(1)
    expect(log[0].reason).toBeTruthy()
    await client.close()
  })
})

describe("buildMcpServer — rag_search dispatch", () => {
  it("allows scope='runtime' under rag:cognia (previously always denied)", async () => {
    const { client } = await makeWiredPair(settings({ enabledScopes: ["rag:cognia"] }))
    const result = await client.callTool({
      name: "rag_search",
      arguments: { query: "anything", scope: "runtime" },
    })
    expect(result.isError).not.toBe(true)
    await client.close()
  })

  it("accepts the expand/grade/trim/rerank toggles", async () => {
    await createWikiArticle({
      slug: "lib-foo",
      title: "lib/foo twin distill",
      module: "lib/foo",
      corpusId: "cognia-self",
      scope: "cognia-self",
      pageRank: 0.5,
      summary: "twin distill orchestrator",
      sectionIds: [],
      sourceRefs: [],
      contentMd: "body",
      embedding: [],
      generatorVersion: "v1",
      fileHashes: {},
    })
    const { client } = await makeWiredPair(settings())
    const result = await client.callTool({
      name: "rag_search",
      arguments: { query: "twin distill", expand: true, grade: true, trim: false, rerank: true },
    })
    expect(result.isError).not.toBe(true)
    await client.close()
  })

  it("audits a user-repo call under rag:user-repo (not rag:cognia)", async () => {
    const { client } = await makeWiredPair(
      settings({ enabledScopes: ["rag:cognia", "rag:user-repo"] })
    )
    await client.callTool({
      name: "rag_search",
      arguments: { query: "anything", scope: "user-repo" },
    })
    const rows = await listMcpAuditLog()
    const ragRows = rows.filter((r) => r.tool === "rag_search")
    expect(ragRows.length).toBeGreaterThanOrEqual(1)
    expect(ragRows.some((r) => r.scope === "rag:user-repo")).toBe(true)
    await client.close()
  })
})

describe("buildMcpServer — wiki resource R7 wrapping", () => {
  it("returns the wiki article body wrapped in <untrusted_content>", async () => {
    await createWikiArticle({
      slug: "lib-foo",
      title: "lib/foo",
      module: "lib/foo",
      corpusId: "cognia-self",
      scope: "cognia-self",
      pageRank: 0.5,
      summary: "s",
      sectionIds: [],
      sourceRefs: [],
      contentMd: "# real body",
      embedding: [],
      generatorVersion: "v1",
      fileHashes: {},
    })
    const { client } = await makeWiredPair(settings())
    const res = (await client.readResource({ uri: "cognia://wiki/lib-foo" })) as {
      contents: { text: string }[]
    }
    expect(res.contents[0].text).toBe("<untrusted_content>\n# real body\n</untrusted_content>")
    await client.close()
  })
})

describe("internal helpers", () => {
  it("mapEntityToScope covers every runtime entity type", () => {
    expect(__TESTING__.mapEntityToScope("skill")).toBe("runtime:skills")
    expect(__TESTING__.mapEntityToScope("character")).toBe("runtime:characters")
    expect(__TESTING__.mapEntityToScope("twin")).toBe("runtime:twins")
    expect(__TESTING__.mapEntityToScope("plugin")).toBe("runtime:plugins")
    expect(__TESTING__.mapEntityToScope("agent-team")).toBe("runtime:agent-teams")
    expect(__TESTING__.mapEntityToScope("nope")).toBe("n/a")
  })
})

describe("buildMcpServer — prompts (cognia-character)", () => {
  // `client.listPrompts()` round-trips argsSchema through zod-to-json-schema,
  // hitting the same SDK 1.29 + zod 4.3 compat issue noted for `listTools()`.
  // We use the low-level request so prompt-list semantics are still asserted.
  async function listPromptNames(client: Client): Promise<string[]> {
    const res = (await client.request(
      { method: "prompts/list", params: {} },
      // Minimal result schema — we only read names.
      (await import("@modelcontextprotocol/sdk/types.js")).ListPromptsResultSchema
    )) as { prompts: { name: string }[] }
    return res.prompts.map((p) => p.name)
  }

  it("lists exactly the three prompt names (no persona content leaks)", async () => {
    const { client } = await makeWiredPair(settings({ enabledScopes: [] }))
    const names = await listPromptNames(client)
    expect(names.sort()).toEqual(["cognia-architecture", "cognia-character", "cognia-howto"])
    await client.close()
  })

  it("returns the persona system prompt when runtime:characters is ON", async () => {
    const char = await createCharacter({
      name: "Sherlock",
      description: "A detective",
      systemPrompt: "You are a brilliant detective.",
    })
    const { client } = await makeWiredPair(settings({ enabledScopes: ["runtime:characters"] }))
    const res = await client.getPrompt({
      name: "cognia-character",
      arguments: { characterId: char.id },
    })
    const text = (res.messages[0].content as { text: string }).text
    expect(text).toContain("Sherlock")
    expect(text).toContain("You are a brilliant detective.")
    await client.close()
  })

  it("denies prompts/get when runtime:characters is OFF", async () => {
    const char = await createCharacter({ name: "X", systemPrompt: "hidden" })
    const { client } = await makeWiredPair(settings({ enabledScopes: [] }))
    await expect(
      client.getPrompt({ name: "cognia-character", arguments: { characterId: char.id } })
    ).rejects.toThrow()
    await client.close()
  })

  it("throws when the character id is unknown (scope ON)", async () => {
    const { client } = await makeWiredPair(settings({ enabledScopes: ["runtime:characters"] }))
    await expect(
      client.getPrompt({ name: "cognia-character", arguments: { characterId: "nope" } })
    ).rejects.toThrow(/not found/)
    await client.close()
  })

  it("records an audit row for prompts/get:character (allow + deny)", async () => {
    const char = await createCharacter({ name: "Y", systemPrompt: "p" })
    const allow = await makeWiredPair(settings({ enabledScopes: ["runtime:characters"] }))
    await allow.client.getPrompt({ name: "cognia-character", arguments: { characterId: char.id } })
    await allow.client.close()
    const deny = await makeWiredPair(settings({ enabledScopes: [] }))
    await deny.client
      .getPrompt({ name: "cognia-character", arguments: { characterId: char.id } })
      .catch(() => undefined)
    await deny.client.close()
    const rows = await listMcpAuditLog()
    const promptRows = rows.filter((r) => r.tool === "prompts/get:character")
    expect(promptRows.length).toBeGreaterThanOrEqual(2)
  })
})

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"

import { loadMcpOperationsSnapshot } from "./operations"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("MCP persisted operations snapshot", () => {
  it("aggregates per-server failures, connect p95, and capability freshness", async () => {
    const db = getDb()
    await db.mcpServers.put({
      id: "srv-1",
      name: "docs",
      displayName: "Docs",
      transport: "http",
      config: { url: "https://mcp.example/rpc" },
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    })
    await db.mcpAuditLog.bulkPut([
      {
        id: "a",
        ts: 100,
        tool: "connect",
        scope: "n/a",
        allowed: true,
        latencyMs: 10,
        direction: "outbound",
        phase: "connect",
        serverId: "srv-1",
        durationMs: 10,
      },
      {
        id: "b",
        ts: 200,
        tool: "connect",
        scope: "n/a",
        allowed: true,
        latencyMs: 30,
        direction: "outbound",
        phase: "connect",
        serverId: "srv-1",
        durationMs: 30,
        errorCode: "connect-failed",
      },
      {
        id: "inbound",
        ts: 300,
        tool: "wiki_search",
        scope: "n/a",
        allowed: false,
        latencyMs: 1,
        direction: "inbound",
        serverId: "srv-1",
        errorCode: "denied",
      },
    ])
    await db.mcpCapabilityCache.put({
      id: "srv-1:fingerprint",
      serverId: "srv-1",
      fingerprint: "fingerprint",
      tools: [],
      resources: [],
      prompts: [],
      updatedAt: 250,
      expiresAt: 550,
    })

    const snapshot = await loadMcpOperationsSnapshot(1_000)
    expect(snapshot.servers).toEqual([
      expect.objectContaining({
        serverId: "srv-1",
        displayName: "Docs",
        events: 2,
        failures: 1,
        failureRate: 0.5,
        lastFailureAt: 200,
        lastErrorCode: "connect-failed",
        connectP95Ms: 30,
        capabilityUpdatedAt: 250,
        capabilityExpiresAt: 550,
      }),
    ])
  })

  it("reports active sync lag without exposing persisted error text", async () => {
    await getDb().mcpSyncJobs.put({
      id: "claude-code",
      desiredRevision: 3,
      tombstones: [],
      status: "retrying",
      attempts: 2,
      nextAttemptAt: 2_000,
      createdAt: 500,
      updatedAt: 900,
      lastError: "Authorization: Bearer must-not-reach-ui",
    })

    const snapshot = await loadMcpOperationsSnapshot(1_500)
    expect(snapshot.sync).toEqual([
      {
        agentId: "claude-code",
        status: "retrying",
        lagMs: 1_000,
        attempts: 2,
        nextAttemptAt: 2_000,
        errorCode: "sync-failed",
      },
    ])
    expect(JSON.stringify(snapshot)).not.toContain("must-not-reach-ui")
  })
})

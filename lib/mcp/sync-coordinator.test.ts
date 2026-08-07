import type { McpSyncJob } from "@cognia/agent-config-types"

const syncToAgent = jest.fn()
jest.mock("@/lib/claude/sync", () => ({
  syncToAgent: (...args: unknown[]) => syncToAgent(...args),
}))

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"

import {
  __resetMcpSyncCoordinatorForTesting,
  drainMcpSyncJobs,
  mcpSyncRetryDelay,
  requestMcpSync,
} from "./sync-coordinator"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  syncToAgent.mockReset()
  await dbFixture.restore()
})
afterEach(__resetMcpSyncCoordinatorForTesting)
afterAll(dbFixture.dispose)

function job(overrides: Partial<McpSyncJob> = {}): McpSyncJob {
  return {
    id: "claude-code",
    desiredRevision: 2,
    tombstones: ["old-name"],
    status: "pending",
    attempts: 0,
    nextAttemptAt: 100,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  }
}

describe("MCP Sync Coordinator", () => {
  it("uses the governed retry schedule and caps at ten minutes", () => {
    expect([1, 2, 3, 4, 5, 20].map(mcpSyncRetryDelay)).toEqual([
      1_000, 5_000, 30_000, 120_000, 600_000, 600_000,
    ])
  })

  it("clears tombstones only after a successful projection", async () => {
    await getDb().mcpSyncJobs.put(job())
    const sync = jest.fn(async () => ({ ok: true as const, result: {} as never, count: 1 }))
    await drainMcpSyncJobs({ now: () => 200, sync })
    expect(sync).toHaveBeenCalledWith("claude-code", ["old-name"])
    expect(await getDb().mcpSyncJobs.get("claude-code")).toMatchObject({
      status: "succeeded",
      tombstones: [],
      attempts: 1,
    })
  })

  it("retains work and schedules a durable retry after failure", async () => {
    await getDb().mcpSyncJobs.put(job())
    await drainMcpSyncJobs({
      now: () => 200,
      sync: async () => ({ ok: false, skipped: false, error: "parse failed" }),
    })
    expect(await getDb().mcpSyncJobs.get("claude-code")).toMatchObject({
      status: "retrying",
      tombstones: ["old-name"],
      attempts: 1,
      nextAttemptAt: 1_200,
      lastError: "parse failed",
    })
  })

  it("automatically drains a failed job again when its persisted retry becomes due", async () => {
    syncToAgent
      .mockResolvedValueOnce({ ok: false, skipped: false, error: "offline" })
      .mockResolvedValueOnce({ ok: true as const, result: {} as never, count: 1 })
    await getDb().mcpSyncJobs.put(job({ nextAttemptAt: Date.now() }))

    await drainMcpSyncJobs()
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    expect(syncToAgent).toHaveBeenCalledTimes(2)
    expect(await getDb().mcpSyncJobs.get("claude-code")).toMatchObject({
      status: "succeeded",
      tombstones: [],
    })
  })

  it("persists manual re-sync requests instead of calling files directly", async () => {
    await getDb().mcpServers.put({
      id: "server",
      name: "server",
      transport: "stdio",
      config: { command: "x" },
      enabled: true,
      revision: 7,
      createdAt: 1,
      updatedAt: 1,
    })
    await requestMcpSync(["claude-code"])
    expect(await getDb().mcpSyncJobs.get("claude-code")).toMatchObject({
      desiredRevision: 7,
      status: "pending",
      attempts: 0,
    })
  })

  it("resets sync-lag age after a completed job but preserves it while coalescing", async () => {
    await getDb().mcpSyncJobs.put(job({ status: "succeeded", createdAt: 1, updatedAt: 2 }))
    const before = Date.now()
    await requestMcpSync(["claude-code"])
    const restarted = await getDb().mcpSyncJobs.get("claude-code")
    expect(restarted?.createdAt).toBeGreaterThanOrEqual(before)

    await getDb().mcpSyncJobs.put(job({ status: "retrying", createdAt: 50, updatedAt: 60 }))
    await requestMcpSync(["claude-code"])
    expect((await getDb().mcpSyncJobs.get("claude-code"))?.createdAt).toBe(50)
  })
})

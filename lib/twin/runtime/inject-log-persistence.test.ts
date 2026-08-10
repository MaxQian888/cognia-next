/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting, whenSeeded } from "@/lib/db/schema"
import { queryRecent } from "@/lib/db/agent-traces"
import { persistTwinInject, readPersistedTwinInjectLog } from "./inject-log"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("Twin inject trace persistence", () => {
  it("persists and restores ID-only retrieval metadata without content", async () => {
    await persistTwinInject({
      id: "1".repeat(16),
      ts: 200,
      twinId: "twin_a",
      source: "chat",
      applied: true,
      degraded: false,
      degradedReason: null,
      chunkCount: 1,
      styleSampleCount: 1,
      tokensApprox: 42,
      durationMs: 20,
      chunkIds: ["chunk_a"],
      chunkScores: [0.91],
      styleSampleIds: ["style_a"],
    })

    const [span] = await queryRecent(10)
    expect(span.providerName).toBe("cognia.twin")
    expect(span.operationName).toBe("retrieval")
    expect(span.metadata).toMatchObject({
      twinId: "twin_a",
      chunkIds: ["chunk_a"],
      chunkScores: [0.91],
      styleSampleIds: ["style_a"],
    })
    expect(JSON.stringify(span)).not.toContain("content")
    expect(JSON.stringify(span)).not.toContain("private@example.com")

    const restored = await readPersistedTwinInjectLog("twin_a")
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ id: "1".repeat(16), chunkIds: ["chunk_a"] })
  })

  it("isolates persisted history by Twin", async () => {
    await persistTwinInject({
      ts: 100,
      twinId: "twin_b",
      source: "workflow",
      applied: false,
      degraded: true,
      degradedReason: "native-unavailable",
      chunkCount: 0,
      styleSampleCount: 0,
      tokensApprox: 0,
    })
    expect(await readPersistedTwinInjectLog("twin_a")).toEqual([])
  })

  it("persists only a bounded degradation code, not raw exception text", async () => {
    await persistTwinInject({
      ts: 300,
      twinId: "twin_a",
      source: "chat",
      applied: false,
      degraded: true,
      degradedReason: "provider-error: request for alice@example.com failed",
      chunkCount: 0,
      styleSampleCount: 0,
      tokensApprox: 0,
    })

    const [span] = await queryRecent(10)
    expect(span.metadata?.degradedReason).toBe("provider-error")
    expect(JSON.stringify(span)).not.toContain("alice@example.com")
  })
})

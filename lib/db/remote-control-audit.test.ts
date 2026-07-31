/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import {
  appendRemoteControlAudit,
  listRemoteControlAudit,
  pruneRemoteControlAudit,
} from "./remote-control-audit"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("remote-control audit", () => {
  it("appends and lists newest-first", async () => {
    await appendRemoteControlAudit({
      direction: "inbound",
      kind: "inbound.command",
      target: "workflow.run",
      runId: "r1",
      result: "accepted",
      at: 1000,
    })
    await appendRemoteControlAudit({
      direction: "outbound",
      kind: "outbound.delivered",
      endpointId: "ep_1",
      result: "delivered",
      at: 2000,
    })
    const rows = await listRemoteControlAudit({ limit: 10 })
    expect(rows).toHaveLength(2)
    expect(rows[0].at).toBe(2000)
    expect(rows[1].runId).toBe("r1")
  })

  it("defaults id and timestamp when not supplied", async () => {
    await appendRemoteControlAudit({ direction: "inbound", kind: "inbound.command" })
    const rows = await listRemoteControlAudit()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toMatch(/.+/)
    expect(rows[0].at).toBeGreaterThan(0)
  })

  it("filters by direction", async () => {
    await appendRemoteControlAudit({ direction: "inbound", kind: "inbound.command", at: 1 })
    await appendRemoteControlAudit({ direction: "outbound", kind: "outbound.failed", at: 2 })
    const inbound = await listRemoteControlAudit({ direction: "inbound" })
    expect(inbound).toHaveLength(1)
    expect(inbound[0].direction).toBe("inbound")
  })

  it("prunes the oldest rows beyond the cap", async () => {
    const table = getDb().remoteControlAudit
    // Seed 1005 rows directly (faster than 1005 appends), then prune.
    const rows = Array.from({ length: 1005 }, (_, i) => ({
      id: `id_${i}`,
      at: i,
      direction: "inbound" as const,
      kind: "inbound.command" as const,
    }))
    await table.bulkAdd(rows)
    await pruneRemoteControlAudit()
    const count = await table.count()
    expect(count).toBe(1000)
    // The five oldest (at 0..4) should be gone.
    const survivors = await table.orderBy("at").first()
    expect(survivors?.at).toBe(5)
  })
})

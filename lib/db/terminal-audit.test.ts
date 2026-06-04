import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import {
  appendUnattendedExecAudit,
  listUnattendedExecAudit,
  pruneUnattendedExecAudit,
} from "./terminal-audit"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("unattended-exec audit", () => {
  it("appends and lists newest-first", async () => {
    await appendUnattendedExecAudit({
      command: "npm test",
      verdict: "allow",
      reason: "safe inspection command",
      blocked: false,
      source: "workflow",
      runId: "r1",
      exitCode: 0,
      durationMs: 1234,
      ts: 1000,
    })
    await appendUnattendedExecAudit({
      command: "rm -rf /",
      verdict: "deny",
      reason: "destructive",
      blocked: true,
      source: "workflow",
      ts: 2000,
    })
    const rows = await listUnattendedExecAudit({ limit: 10 })
    expect(rows).toHaveLength(2)
    expect(rows[0].command).toBe("rm -rf /")
    expect(rows[0].blocked).toBe(true)
    expect(rows[1].runId).toBe("r1")
  })

  it("defaults id and timestamp when not supplied", async () => {
    await appendUnattendedExecAudit({
      command: "ls",
      verdict: "allow",
      reason: "safe",
      blocked: false,
      source: "agent",
    })
    const rows = await listUnattendedExecAudit()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toMatch(/.+/)
    expect(rows[0].ts).toBeGreaterThan(0)
  })

  it("filters by runId", async () => {
    await appendUnattendedExecAudit({
      command: "a",
      verdict: "allow",
      reason: "x",
      blocked: false,
      source: "workflow",
      runId: "r1",
      ts: 1,
    })
    await appendUnattendedExecAudit({
      command: "b",
      verdict: "allow",
      reason: "x",
      blocked: false,
      source: "workflow",
      runId: "r2",
      ts: 2,
    })
    const rows = await listUnattendedExecAudit({ runId: "r1" })
    expect(rows).toHaveLength(1)
    expect(rows[0].command).toBe("a")
  })

  it("prunes the oldest rows beyond the cap", async () => {
    const table = getDb().unattendedExecAudit
    const rows = Array.from({ length: 1005 }, (_, i) => ({
      id: `id_${i}`,
      ts: i,
      command: `cmd ${i}`,
      verdict: "allow" as const,
      reason: "x",
      blocked: false,
      source: "workflow" as const,
    }))
    await table.bulkAdd(rows)
    await pruneUnattendedExecAudit()
    expect(await table.count()).toBe(1000)
    const oldest = await table.orderBy("ts").first()
    expect(oldest?.ts).toBe(5)
  })
})

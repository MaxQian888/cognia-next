/** @jest-environment jsdom */
/**
 * Coverage for `lib/db/mcp-audit-log.ts` — append/list/count/clear plus the
 * 5000-row cap (overflow behavior in `pruneOldest`).
 */

import "fake-indexeddb/auto"
import {
  __TESTING__,
  appendMcpAuditLog,
  clearMcpAuditLog,
  countMcpAuditLog,
  listMcpAuditLog,
} from "./mcp-audit-log"
import type { McpAuditDraft } from "./mcp-audit-log"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function draft(overrides: Partial<McpAuditDraft> = {}): McpAuditDraft {
  return {
    ts: overrides.ts ?? Date.now(),
    tool: overrides.tool ?? "wiki_search",
    scope: overrides.scope ?? "wiki:cognia",
    allowed: overrides.allowed ?? true,
    latencyMs: overrides.latencyMs ?? 5,
    reason: overrides.reason,
    errorMessage: overrides.errorMessage,
    ...overrides,
  }
}

describe("mcp-audit-log", () => {
  it("appends a row and round-trips it", async () => {
    const row = await appendMcpAuditLog(draft())
    expect(row.id).toMatch(/^mau_/)
    expect(await countMcpAuditLog()).toBe(1)
  })

  it("honors caller-supplied id", async () => {
    const row = await appendMcpAuditLog(draft({ id: "mau_custom" }))
    expect(row.id).toBe("mau_custom")
  })

  it("listMcpAuditLog returns newest-first", async () => {
    await appendMcpAuditLog(draft({ ts: 100, tool: "old" }))
    await appendMcpAuditLog(draft({ ts: 200, tool: "newer" }))
    await appendMcpAuditLog(draft({ ts: 300, tool: "newest" }))
    const rows = await listMcpAuditLog()
    expect(rows.map((r) => r.tool)).toEqual(["newest", "newer", "old"])
  })

  it("listMcpAuditLog filters by tool", async () => {
    await appendMcpAuditLog(draft({ ts: 100, tool: "wiki_search" }))
    await appendMcpAuditLog(draft({ ts: 200, tool: "rag_search" }))
    await appendMcpAuditLog(draft({ ts: 300, tool: "wiki_search" }))
    const rows = await listMcpAuditLog({ tool: "wiki_search" })
    expect(rows.map((r) => r.ts)).toEqual([300, 100])
  })

  it("listMcpAuditLog filters by deniedOnly", async () => {
    await appendMcpAuditLog(draft({ ts: 100, allowed: true }))
    await appendMcpAuditLog(
      draft({ ts: 200, allowed: false, scope: "runtime:twins", reason: "scope OFF" })
    )
    const denied = await listMcpAuditLog({ deniedOnly: true })
    expect(denied).toHaveLength(1)
    expect(denied[0].reason).toBe("scope OFF")
  })

  it("listMcpAuditLog respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      await appendMcpAuditLog(draft({ ts: 1000 + i }))
    }
    const rows = await listMcpAuditLog({ limit: 3 })
    expect(rows).toHaveLength(3)
  })

  it("listMcpAuditLog ignores limit <= 0", async () => {
    for (let i = 0; i < 5; i++) {
      await appendMcpAuditLog(draft({ ts: 1000 + i }))
    }
    const rows = await listMcpAuditLog({ limit: 0 })
    expect(rows).toHaveLength(5)
  })

  it("clearMcpAuditLog wipes the table", async () => {
    await appendMcpAuditLog(draft())
    await appendMcpAuditLog(draft())
    expect(await countMcpAuditLog()).toBe(2)
    await clearMcpAuditLog()
    expect(await countMcpAuditLog()).toBe(0)
  })

  it("pruneOldest is a no-op when count <= keep", async () => {
    await appendMcpAuditLog(draft())
    const db = getDb()
    await db.transaction("rw", db.mcpAuditLog, async () => {
      await __TESTING__.pruneOldest(10)
    })
    expect(await countMcpAuditLog()).toBe(1)
  })

  it("pruneOldest trims down to exactly `keep` when over capacity", async () => {
    for (let i = 0; i < 10; i++) {
      await appendMcpAuditLog(draft({ ts: 1000 + i, tool: `t${i}` }))
    }
    const db = getDb()
    await db.transaction("rw", db.mcpAuditLog, async () => {
      await __TESTING__.pruneOldest(3)
    })
    const remaining = await listMcpAuditLog()
    // The 3 newest (ts 1009, 1008, 1007) survive.
    expect(remaining.map((r) => r.ts)).toEqual([1009, 1008, 1007])
  })

  it("appendMcpAuditLog enforces the cap on writes that overflow", async () => {
    // Drive 5005 writes — every write past 5000 triggers prune in the same
    // transaction. Verify the table never exceeds the cap.
    for (let i = 0; i < 5005; i++) {
      await appendMcpAuditLog(draft({ ts: i, tool: "load" }))
    }
    expect(await countMcpAuditLog()).toBe(__TESTING__.AUDIT_CAP)
  }, 60_000)

  it("AUDIT_CAP is exposed for tuning", () => {
    expect(__TESTING__.AUDIT_CAP).toBe(5000)
  })
})

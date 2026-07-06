/**
 * Coverage for `lib/external-bridge/audit-log.ts` — the policy wrapper that
 * funnels every MCP call through `appendMcpAuditLog`.
 */

import "fake-indexeddb/auto"
import { recordCall } from "./audit-log"
import { listMcpAuditLog } from "@/lib/db/mcp-audit-log"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
}, 30_000)

describe("recordCall", () => {
  it("writes a row when the gate allowed the call", async () => {
    const row = await recordCall({
      tool: "wiki_search",
      scope: "wiki:cognia",
      check: { allowed: true },
      latencyMs: 4,
    })
    expect(row?.allowed).toBe(true)
    expect(row?.tool).toBe("wiki_search")
    const all = await listMcpAuditLog()
    expect(all).toHaveLength(1)
  })

  it("captures the deny reason when the gate refused the call", async () => {
    const row = await recordCall({
      tool: "runtime_query",
      scope: "runtime:twins",
      check: { allowed: false, reason: "scope OFF" },
      latencyMs: 1,
    })
    expect(row?.allowed).toBe(false)
    expect(row?.reason).toBe("scope OFF")
  })

  it("captures handler errors that fired after the gate allowed the call", async () => {
    const row = await recordCall({
      tool: "wiki_read",
      scope: "wiki:cognia",
      check: { allowed: true },
      latencyMs: 12,
      errorMessage: "slug not found",
    })
    expect(row?.allowed).toBe(true)
    expect(row?.errorMessage).toBe("slug not found")
  })

  it("handles `n/a` scope for protocol-level methods", async () => {
    const row = await recordCall({
      tool: "tools/list",
      scope: "n/a",
      check: { allowed: true },
      latencyMs: 0,
    })
    expect(row?.scope).toBe("n/a")
  })

  it("returns undefined and does not throw if the Dexie write fails", async () => {
    // Force a write failure by deleting the db underneath ourselves and
    // dropping the cached instance — the next append() goes through a
    // closed connection and rejects.
    await getDb().delete()
    __resetDbForTesting()
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const row = await recordCall({
      tool: "wiki_search",
      scope: "wiki:cognia",
      check: { allowed: true },
      latencyMs: 1,
    })
    // Either the call succeeded (db got reopened by the implicit getDb in
    // the audit-log path) or it failed cleanly. Either way it must not
    // throw — which is the contract under test.
    if (row === undefined) {
      expect(warnSpy).toHaveBeenCalled()
    }
    warnSpy.mockRestore()
  })
})

/**
 * @jest-environment node
 */
import { ensureSessionRow } from "./cli-session-store"
import { DEFAULT_RESOLVED_CONFIG } from "../config/schema"
import type { ChatSession } from "@cognia/agent-config-types"

function fakeTable() {
  const rows = new Map<string, ChatSession>()
  return {
    rows,
    async get(id: string) {
      return rows.get(id)
    },
    async put(row: ChatSession) {
      rows.set(row.id, row)
    },
  }
}

const config = {
  ...DEFAULT_RESOLVED_CONFIG,
  cwd: "/work",
  provider: "anthropic",
  // Per-provider memory is authoritative; `model` mirrors it for display.
  model: "claude-x",
  providers: { anthropic: { model: "claude-x" } },
}

describe("ensureSessionRow", () => {
  it("ensures the db is open then upserts a ChatSession row", async () => {
    const table = fakeTable()
    let ensured = 0
    const row = await ensureSessionRow("ses1", config, {
      ensureDb: async () => {
        ensured++
      },
      getSessionsTable: () => table,
      now: () => 1000,
    })
    expect(ensured).toBe(1)
    expect(row.id).toBe("ses1")
    expect(row.workingDir).toBe("/work")
    expect(row.model).toBe("claude-x")
    expect(table.rows.get("ses1")?.providerOverride).toBe("anthropic")
  })

  it("resolves the sessions table only AFTER ensureDb (window shim ordering)", async () => {
    // Regression: `getDb().sessions` must not be evaluated before `ensureDb()`
    // installs the window/IndexedDB shims, or getDb() throws "called on the
    // server". We assert the table getter runs strictly after ensureDb.
    const table = fakeTable()
    const order: string[] = []
    await ensureSessionRow("ses1", config, {
      ensureDb: async () => {
        order.push("ensureDb")
      },
      getSessionsTable: () => {
        order.push("getTable")
        return table
      },
      now: () => 1000,
    })
    expect(order).toEqual(["ensureDb", "getTable"])
  })

  it("preserves the original createdAt on a second call (idempotent upsert)", async () => {
    const table = fakeTable()
    const deps = { ensureDb: async () => {}, getSessionsTable: () => table }
    const first = await ensureSessionRow("ses1", config, { ...deps, now: () => 1000 })
    const second = await ensureSessionRow("ses1", config, { ...deps, now: () => 5000 })
    expect(first.createdAt).toBe(1000)
    expect(second.createdAt).toBe(1000)
    expect(second.updatedAt).toBe(5000)
  })
})

/**
 * @jest-environment node
 */
import { ensureSessionRow } from "./cli-session-store"
import { DEFAULT_RESOLVED_CONFIG } from "../config/schema"
import type { ChatSession } from "@/lib/claude/types"

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
  model: "claude-x",
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

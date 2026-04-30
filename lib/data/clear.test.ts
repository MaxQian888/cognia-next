jest.mock("@/lib/db/schema", () => {
  const tables: Record<string, { clear: jest.Mock }> = {}
  const names = [
    "sessions",
    "messages",
    "sessionState",
    "characters",
    "skills",
    "teams",
    "promptPresets",
    "mcpServers",
    "settings",
  ]
  for (const n of names) {
    tables[n] = { clear: jest.fn(async () => undefined) }
  }
  const db = {
    ...tables,
    transaction: jest.fn(async (_mode: string, _tables: unknown[], cb: () => Promise<void>) => {
      await cb()
    }),
    delete: jest.fn(async () => undefined),
  }
  return { getDb: () => db, __db: db }
})

import { clearTables, clearAll } from "./clear"
// Pull a reference to the mocked db
import * as schema from "@/lib/db/schema"

const db = (
  schema as unknown as {
    __db: Record<string, { clear: jest.Mock } | jest.Mock> & {
      transaction: jest.Mock
      delete: jest.Mock
    }
  }
).__db

beforeEach(() => {
  jest.clearAllMocks()
})

describe("clearTables", () => {
  it("returns immediately when given no names", async () => {
    await clearTables([])
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it("clears messages, sessionState, sessions when 'sessions' is requested", async () => {
    await clearTables(["sessions"])
    expect((db.messages as { clear: jest.Mock }).clear).toHaveBeenCalledTimes(1)
    expect((db.sessionState as { clear: jest.Mock }).clear).toHaveBeenCalledTimes(1)
    expect((db.sessions as { clear: jest.Mock }).clear).toHaveBeenCalledTimes(1)
  })

  it("clears every requested table", async () => {
    await clearTables(["characters", "skills", "teams", "promptPresets", "mcpServers", "settings"])
    expect((db.characters as { clear: jest.Mock }).clear).toHaveBeenCalled()
    expect((db.skills as { clear: jest.Mock }).clear).toHaveBeenCalled()
    expect((db.teams as { clear: jest.Mock }).clear).toHaveBeenCalled()
    expect((db.promptPresets as { clear: jest.Mock }).clear).toHaveBeenCalled()
    expect((db.mcpServers as { clear: jest.Mock }).clear).toHaveBeenCalled()
    expect((db.settings as { clear: jest.Mock }).clear).toHaveBeenCalled()
  })

  it("does not clear tables that were not asked for", async () => {
    await clearTables(["characters"])
    expect((db.characters as { clear: jest.Mock }).clear).toHaveBeenCalled()
    expect((db.skills as { clear: jest.Mock }).clear).not.toHaveBeenCalled()
    expect((db.settings as { clear: jest.Mock }).clear).not.toHaveBeenCalled()
  })
})

describe("clearAll", () => {
  it("calls db.delete()", async () => {
    await clearAll()
    expect(db.delete).toHaveBeenCalledTimes(1)
  })
})

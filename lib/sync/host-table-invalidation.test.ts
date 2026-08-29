/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import { getDb, whenSeeded } from "@/lib/db/schema"

import {
  __resetHostTableInvalidationForTests,
  installHostTableInvalidation,
  SYNC_TABLE_SOURCES,
} from "./host-table-invalidation"
import { SYNCABLE_TABLE_NAMES, type SyncableTable } from "./types"

type Handler = (...args: unknown[]) => void

/** A Dexie-shaped hook registry: subscribe by event, unsubscribe by identity. */
function makeStubTable() {
  const handlers = new Map<string, Set<Handler>>()
  const registry = {
    hook(event: string, handler?: Handler) {
      const set = handlers.get(event) ?? new Set<Handler>()
      handlers.set(event, set)
      if (handler) {
        set.add(handler)
        return undefined
      }
      return {
        unsubscribe(target: Handler) {
          set.delete(target)
        },
      }
    },
  }
  return {
    table: registry as never,
    handlers,
    fire(event: string) {
      for (const handler of handlers.get(event) ?? []) handler()
    },
    count() {
      let total = 0
      for (const set of handlers.values()) total += set.size
      return total
    },
  }
}

beforeEach(() => {
  __resetHostTableInvalidationForTests()
})

describe("SYNC_TABLE_SOURCES", () => {
  it("names a source table for every table in the sync protocol", () => {
    expect(Object.keys(SYNC_TABLE_SOURCES).sort()).toEqual([...SYNCABLE_TABLE_NAMES].sort())
  })

  it("routes the wire aliases to the tables the sync source actually reads", () => {
    // These three are the only names that differ, and each differs for a
    // reason: two wire aliases (ADR-0045) and one projection.
    expect(SYNC_TABLE_SOURCES.goals).toBe("chatGoals")
    expect(SYNC_TABLE_SOURCES.plans).toBe("agentPlans")
    expect(SYNC_TABLE_SOURCES.mcpServers).toBe("mcpServerSummaries")
  })

  it("resolves to a real table on the account database", async () => {
    // The map is the contract between this module and the schema; a rename in
    // `lib/db/schema.ts` must fail here rather than silently stop pushing.
    await whenSeeded()
    const db = getDb() as unknown as Record<string, unknown>
    for (const table of SYNCABLE_TABLE_NAMES) {
      expect(db[SYNC_TABLE_SOURCES[table]]).toBeDefined()
    }
  })
})

describe("installHostTableInvalidation", () => {
  it("publishes for every syncable table, on create, update and delete", () => {
    const stubs = new Map<string, ReturnType<typeof makeStubTable>>()
    const published: SyncableTable[] = []

    const teardown = installHostTableInvalidation({
      getTable: (name) => {
        const stub = makeStubTable()
        stubs.set(name, stub)
        return stub.table
      },
      publish: (table) => published.push(table),
    })

    expect(stubs.size).toBe(SYNCABLE_TABLE_NAMES.length)
    for (const event of ["creating", "updating", "deleting"] as const) {
      published.length = 0
      for (const stub of stubs.values()) stub.fire(event)
      expect(new Set(published)).toEqual(new Set(SYNCABLE_TABLE_NAMES))
    }

    teardown()
  })

  it("publishes the protocol name, not the Dexie table name", () => {
    const stubs = new Map<string, ReturnType<typeof makeStubTable>>()
    const published: SyncableTable[] = []

    installHostTableInvalidation({
      getTable: (name) => {
        const stub = makeStubTable()
        stubs.set(name, stub)
        return stub.table
      },
      publish: (table) => published.push(table),
    })

    stubs.get("chatGoals")?.fire("creating")
    stubs.get("agentPlans")?.fire("updating")
    stubs.get("mcpServerSummaries")?.fire("deleting")

    expect(published).toEqual(["goals", "plans", "mcpServers"])
  })

  it("unsubscribes every hook on teardown", () => {
    const stubs: ReturnType<typeof makeStubTable>[] = []
    const teardown = installHostTableInvalidation({
      getTable: () => {
        const stub = makeStubTable()
        stubs.push(stub)
        return stub.table
      },
      publish: () => {},
    })

    expect(stubs.every((stub) => stub.count() === 3)).toBe(true)
    teardown()
    expect(stubs.every((stub) => stub.count() === 0)).toBe(true)
  })

  it("is a no-op while an install is already live", () => {
    const published: SyncableTable[] = []
    const stubs: ReturnType<typeof makeStubTable>[] = []
    const first = installHostTableInvalidation({
      getTable: () => {
        const stub = makeStubTable()
        stubs.push(stub)
        return stub.table
      },
      publish: (table) => published.push(table),
    })
    const created = stubs.length

    const second = installHostTableInvalidation({
      getTable: () => makeStubTable().table,
      publish: (table) => published.push(table),
    })
    second()

    // The second install hooked nothing, and its teardown did not detach the
    // first — a re-running provider effect must not silently stop the push.
    expect(stubs).toHaveLength(created)
    expect(stubs[0].count()).toBe(3)
    first()
  })

  it("skips a table the database does not have instead of losing the rest", () => {
    const published: SyncableTable[] = []
    const stubs = new Map<string, ReturnType<typeof makeStubTable>>()

    installHostTableInvalidation({
      getTable: (name) => {
        if (name === "terminalHistory") return undefined
        const stub = makeStubTable()
        stubs.set(name, stub)
        return stub.table
      },
      publish: (table) => published.push(table),
    })

    for (const stub of stubs.values()) stub.fire("creating")
    expect(published).toHaveLength(SYNCABLE_TABLE_NAMES.length - 1)
    expect(published).not.toContain("terminalHistory")
  })

  it("keeps the write alive when publishing throws", () => {
    const stubs: ReturnType<typeof makeStubTable>[] = []
    installHostTableInvalidation({
      getTable: () => {
        const stub = makeStubTable()
        stubs.push(stub)
        return stub.table
      },
      publish: () => {
        throw new Error("bridge is down")
      },
    })

    // The hook runs inside the Dexie transaction that wrote the row; a throw
    // here would fail that write.
    expect(() => stubs[0].fire("creating")).not.toThrow()
  })
})

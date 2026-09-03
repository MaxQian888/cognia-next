/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"

import { runSyncHandler } from "./base"
import type { SyncDelta } from "../types"

interface FakeRow {
  id: string
  name: string
  isBuiltIn?: boolean
}

function makeFakeTable() {
  const store = new Map<string, FakeRow>()
  return {
    store,
    table: {
      bulkPut: jest.fn(async (rows: FakeRow[]) => {
        for (const r of rows) store.set(r.id, r)
      }),
      bulkDelete: jest.fn(async (ids: string[]) => {
        for (const id of ids) store.delete(id)
      }),
    } as unknown as import("dexie").Table<FakeRow, string>,
  }
}

function makeTransport(response: SyncDelta<FakeRow> | Error): Transport {
  return {
    call: jest.fn(async () => {
      if (response instanceof Error) throw response
      return response
    }) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("runSyncHandler", () => {
  it("upserts rows + deletes tombstones on success", async () => {
    const fake = makeFakeTable()
    const transport = makeTransport({
      rows: [{ id: "a", name: "alpha" }],
      deleted_ids: ["b"],
      next_since: 42,
    })

    const out = await runSyncHandler<FakeRow>(
      { table: "characters", getTable: () => fake.table },
      transport,
      { since: 0 }
    )

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.applied).toBe(2)
    expect(out.result.nextSince).toBe(42)
    expect(fake.table.bulkPut).toHaveBeenCalledWith([{ id: "a", name: "alpha" }])
    expect(fake.table.bulkDelete).toHaveBeenCalledWith(["b"])
  })

  it("applies a row filter before bulkPut", async () => {
    const fake = makeFakeTable()
    const transport = makeTransport({
      rows: [
        { id: "a", name: "user", isBuiltIn: false },
        { id: "b", name: "builtin", isBuiltIn: true },
      ],
      deleted_ids: [],
      next_since: 1,
    })

    const out = await runSyncHandler<FakeRow>(
      {
        table: "characters",
        getTable: () => fake.table,
        rowFilter: (row) => !row.isBuiltIn,
      },
      transport,
      { since: 0 }
    )

    expect(out.ok).toBe(true)
    expect(fake.table.bulkPut).toHaveBeenCalledWith([{ id: "a", name: "user", isBuiltIn: false }])
  })

  it("classifies a 404 / 'not found' transport error as not_implemented", async () => {
    const fake = makeFakeTable()
    const transport = makeTransport(new Error("HTTP 404 — sync_pull command not found"))

    const out = await runSyncHandler<FakeRow>(
      { table: "characters", getTable: () => fake.table },
      transport,
      { since: 0 }
    )

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.failure.reason).toBe("not_implemented")
  })

  it("classifies generic transport errors as transport", async () => {
    const fake = makeFakeTable()
    const transport = makeTransport(new Error("network unreachable"))

    const out = await runSyncHandler<FakeRow>(
      { table: "characters", getTable: () => fake.table },
      transport,
      { since: 0 }
    )

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.failure.reason).toBe("transport")
    expect(out.failure.message).toContain("network unreachable")
  })

  // A quota refusal says nothing about the table. Folded into `transport` it
  // read as "this table is broken", and the orchestrator moved straight on to
  // spend the next token that was not there.
  it("classifies a quota refusal as rate_limited and keeps the host's wait", async () => {
    const fake = makeFakeTable()
    const refusal = Object.assign(
      new Error("device exceeded the remote execution quota; retry_after_seconds=3"),
      { code: "rate_limited", retryable: true, retryAfterMs: 3_000 }
    )
    const transport = makeTransport(refusal)

    const out = await runSyncHandler<FakeRow>(
      { table: "characters", getTable: () => fake.table },
      transport,
      { since: 0 }
    )

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.failure.reason).toBe("rate_limited")
    expect(out.failure.retryAfterMs).toBe(3_000)
  })

  it("still recognises a quota refusal from a host that stated no wait", async () => {
    const fake = makeFakeTable()
    const refusal = Object.assign(new Error("HTTP 429"), { code: "http_429" })
    const transport = makeTransport(refusal)

    const out = await runSyncHandler<FakeRow>(
      { table: "characters", getTable: () => fake.table },
      transport,
      { since: 0 }
    )

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.failure.reason).toBe("rate_limited")
    expect(out.failure.retryAfterMs).toBeUndefined()
  })

  it("does not mistake an unrelated error mentioning 429 rows for a refusal", async () => {
    const fake = makeFakeTable()
    const transport = makeTransport(new Error("network unreachable"))

    const out = await runSyncHandler<FakeRow>(
      { table: "characters", getTable: () => fake.table },
      transport,
      { since: 0 }
    )

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.failure.reason).toBe("transport")
  })

  it("classifies Dexie schema errors as schema", async () => {
    const transport = makeTransport({
      rows: [{ id: "a", name: "alpha" }],
      deleted_ids: [],
      next_since: 1,
    })
    const tableMock = {
      bulkPut: jest.fn(async () => {
        throw new Error("schema mismatch")
      }),
      bulkDelete: jest.fn(),
    } as unknown as import("dexie").Table<FakeRow, string>

    const out = await runSyncHandler<FakeRow>(
      { table: "characters", getTable: () => tableMock },
      transport,
      { since: 0 }
    )

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.failure.reason).toBe("schema")
  })

  it("skips bulkPut when there are no upserts", async () => {
    const fake = makeFakeTable()
    const transport = makeTransport({ rows: [], deleted_ids: ["zz"], next_since: 5 })

    await runSyncHandler<FakeRow>({ table: "characters", getTable: () => fake.table }, transport, {
      since: 0,
    })

    expect(fake.table.bulkPut).not.toHaveBeenCalled()
    expect(fake.table.bulkDelete).toHaveBeenCalledWith(["zz"])
  })

  it("skips bulkDelete when there are no tombstones", async () => {
    const fake = makeFakeTable()
    const transport = makeTransport({
      rows: [{ id: "x", name: "x" }],
      deleted_ids: [],
      next_since: 10,
    })

    await runSyncHandler<FakeRow>({ table: "characters", getTable: () => fake.table }, transport, {
      since: 0,
    })

    expect(fake.table.bulkDelete).not.toHaveBeenCalled()
  })

  it("passes the cursor to the transport call", async () => {
    const fake = makeFakeTable()
    const transport = makeTransport({ rows: [], deleted_ids: [], next_since: 99 })

    await runSyncHandler<FakeRow>({ table: "characters", getTable: () => fake.table }, transport, {
      since: 25,
    })

    expect(transport.call).toHaveBeenCalledWith("sync_pull", {
      table: "characters",
      since: 25,
      content_protocol_version: 1,
    })
  })

  it("surfaces protocol rejection as upgrade_required", async () => {
    const fake = makeFakeTable()
    const transport = makeTransport(new Error("upgrade_required: content protocol v1 is required"))

    const out = await runSyncHandler<FakeRow>(
      { table: "memories", getTable: () => fake.table },
      transport,
      { since: 0 }
    )

    expect(out).toMatchObject({
      ok: false,
      failure: { table: "memories", reason: "upgrade_required" },
    })
  })

  it("does a single pull when has_more is unset", async () => {
    const fake = makeFakeTable()
    const transport = makeTransport({
      rows: [{ id: "a", name: "a" }],
      deleted_ids: [],
      next_since: 1,
    })
    await runSyncHandler<FakeRow>({ table: "messages", getTable: () => fake.table }, transport, {
      since: 0,
    })
    expect(transport.call).toHaveBeenCalledTimes(1)
  })

  it("drains pages while has_more is set, advancing the cursor each page", async () => {
    const fake = makeFakeTable()
    const deltas: SyncDelta<FakeRow>[] = [
      { rows: [{ id: "a", name: "a" }], deleted_ids: [], next_since: 1, has_more: true },
      { rows: [{ id: "b", name: "b" }], deleted_ids: [], next_since: 2, has_more: true },
      { rows: [], deleted_ids: [], next_since: 2, has_more: false },
    ]
    let i = 0
    const call = jest.fn(async () => deltas[Math.min(i++, deltas.length - 1)])
    const transport = {
      call: call as unknown as Transport["call"],
      subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
    }

    const out = await runSyncHandler<FakeRow>(
      { table: "messages", getTable: () => fake.table },
      transport,
      { since: 0 }
    )
    expect(call).toHaveBeenCalledTimes(3)
    expect((call.mock.calls[1] as unknown[])[1]).toEqual({
      table: "messages",
      since: 1,
      content_protocol_version: 1,
    })
    expect((call.mock.calls[2] as unknown[])[1]).toEqual({
      table: "messages",
      since: 2,
      content_protocol_version: 1,
    })
    expect(out.ok && out.result.applied).toBe(2)
    expect(out.ok && out.result.nextSince).toBe(2)
  })

  it("uses applyRows override instead of bulkPut when provided", async () => {
    const fake = makeFakeTable()
    const applyRows = jest.fn(async () => {})
    await runSyncHandler<FakeRow>(
      { table: "settings", getTable: () => fake.table, applyRows },
      makeTransport({ rows: [{ id: "singleton", name: "s" }], deleted_ids: [], next_since: 5 }),
      { since: 0 }
    )
    expect(applyRows).toHaveBeenCalledWith([{ id: "singleton", name: "s" }])
    expect(fake.table.bulkPut).not.toHaveBeenCalled()
  })

  it("writes a large page in slices so no single job holds the main thread", async () => {
    const fake = makeFakeTable()
    const rows = Array.from({ length: 450 }, (_, i) => ({ id: `m${i}`, name: "m" }))
    const out = await runSyncHandler<FakeRow>(
      { table: "messages", getTable: () => fake.table },
      makeTransport({ rows, deleted_ids: [], next_since: 9 }),
      { since: 0 }
    )

    expect(out.ok).toBe(true)
    // 450 rows at the 200-row slice size — three writes, not one.
    expect(fake.table.bulkPut).toHaveBeenCalledTimes(3)
    expect(fake.store.size).toBe(450)
  })

  it("slices tombstone deletes too", async () => {
    const fake = makeFakeTable()
    const ids = Array.from({ length: 250 }, (_, i) => `gone-${i}`)
    for (const id of ids) fake.store.set(id, { id, name: "x" })

    await runSyncHandler<FakeRow>(
      { table: "messages", getTable: () => fake.table, applySliceSize: 100 },
      makeTransport({ rows: [], deleted_ids: ids, next_since: 3 }),
      { since: 0 }
    )

    expect(fake.table.bulkDelete).toHaveBeenCalledTimes(3)
    expect(fake.store.size).toBe(0)
  })

  it("calls an applyRows override once per slice, over disjoint rows", async () => {
    const fake = makeFakeTable()
    const seen: string[][] = []
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, name: "r" }))

    await runSyncHandler<FakeRow>(
      {
        table: "memories",
        getTable: () => fake.table,
        applySliceSize: 2,
        applyRows: async (slice) => {
          seen.push(slice.map((row) => row.id))
        },
      },
      makeTransport({ rows, deleted_ids: [], next_since: 1 }),
      { since: 0 }
    )

    expect(seen).toEqual([["r0", "r1"], ["r2", "r3"], ["r4"]])
    expect(fake.table.bulkPut).not.toHaveBeenCalled()
  })

  it("bails out after MAX_PAGES if the server never clears has_more", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const fake = makeFakeTable()
    let n = 0
    const transport = {
      call: jest.fn(async () => ({
        rows: [{ id: `m${n}`, name: "m" }],
        deleted_ids: [],
        next_since: ++n,
        has_more: true,
      })) as unknown as Transport["call"],
      subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
    }
    const out = await runSyncHandler<FakeRow>(
      { table: "messages", getTable: () => fake.table },
      transport,
      { since: 0 }
    )
    expect(transport.call).toHaveBeenCalledTimes(100)
    expect(out.ok).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

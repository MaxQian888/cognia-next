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
    })
  })
})

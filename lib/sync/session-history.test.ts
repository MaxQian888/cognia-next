/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"

import { __resetHydratedSessionHistoryForTests, hydrateSessionHistory } from "./session-history"

function createTransport(call: jest.Mock): Transport {
  return {
    call: call as unknown as Transport["call"],
    subscribe: () => () => {},
  }
}

describe("hydrateSessionHistory", () => {
  beforeEach(async () => {
    __resetHydratedSessionHistoryForTests()
    await getDb().messages.clear()
  })

  it("drains one selected session in bounded pages and caches completion", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      sessionId: "s1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: String(i) }],
      createdAt: i + 1,
    }))
    const call = jest.fn(async (_name: string, args?: Record<string, unknown>) => {
      const offset = Number(args?.offset ?? 0)
      const limit = Number(args?.limit ?? 2)
      const pageRows = rows.slice(offset, offset + limit)
      return {
        rows: pageRows,
        total: rows.length,
        next_offset: offset + pageRows.length < rows.length ? offset + pageRows.length : undefined,
      }
    })
    const transport = createTransport(call)

    const outcome = await hydrateSessionHistory(transport, "s1", { pageSize: 2 })

    expect(outcome).toEqual({ applied: 5, total: 5 })
    expect(call.mock.calls.map(([, args]) => args)).toEqual([
      { session_id: "s1", limit: 2, offset: 0 },
      { session_id: "s1", limit: 2, offset: 2 },
      { session_id: "s1", limit: 2, offset: 4 },
    ])
    expect(
      (await getDb().messages.where("sessionId").equals("s1").toArray()).map((row) => row.id)
    ).toEqual(["m0", "m1", "m2", "m3", "m4"])

    await hydrateSessionHistory(transport, "s1", { pageSize: 2 })
    expect(call).toHaveBeenCalledTimes(3)
  })

  it("coalesces concurrent hydration for the same session", async () => {
    let resolvePage: ((page: { rows: never[]; total: number }) => void) | undefined
    const call = jest.fn(
      () =>
        new Promise<{ rows: never[]; total: number }>((resolve) => {
          resolvePage = resolve
        })
    )
    const transport = createTransport(call)

    const first = hydrateSessionHistory(transport, "s1")
    const second = hydrateSessionHistory(transport, "s1")

    expect(second).toBe(first)
    expect(call).toHaveBeenCalledTimes(1)
    resolvePage?.({ rows: [], total: 0 })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { applied: 0, total: 0 },
      { applied: 0, total: 0 },
    ])
  })

  it("clamps caller-provided page sizes to the protocol bounds", async () => {
    const call = jest.fn(async (_name: string, _args?: Record<string, unknown>) => ({
      rows: [],
      total: 0,
    }))
    const transport = createTransport(call)

    await hydrateSessionHistory(transport, "large", { pageSize: 999 })
    await hydrateSessionHistory(transport, "small", { pageSize: 0 })

    expect(call.mock.calls.map(([, args]) => args?.limit)).toEqual([500, 1])
  })

  it("derives the final total when the indexed bridge omits an exact count", async () => {
    const transport = createTransport(
      jest.fn(async () => ({
        rows: [
          {
            id: "m1",
            sessionId: "s1",
            role: "user",
            parts: [],
            createdAt: 1,
          },
        ],
      }))
    )

    await expect(hydrateSessionHistory(transport, "s1")).resolves.toEqual({
      applied: 1,
      total: 1,
    })
  })

  it("rejects an invalid page without persisting rows", async () => {
    const transport = createTransport(jest.fn(async () => ({ rows: null, total: -1 }) as never))

    await expect(hydrateSessionHistory(transport, "s1")).rejects.toThrow(
      /invalid session history page/
    )
    expect(await getDb().messages.count()).toBe(0)
  })

  it("rejects a page whose cursor does not advance", async () => {
    const transport = createTransport(jest.fn(async () => ({ rows: [], total: 1, next_offset: 0 })))

    await expect(hydrateSessionHistory(transport, "s1")).rejects.toThrow(/did not advance/)
  })

  it("rejects a page that leaks rows from another session", async () => {
    const transport = createTransport(
      jest.fn(async () => ({
        rows: [
          {
            id: "m-other",
            sessionId: "other",
            role: "user",
            parts: [],
            createdAt: 1,
          },
        ],
        total: 1,
      }))
    )

    await expect(hydrateSessionHistory(transport, "s1")).rejects.toThrow(/session mismatch/)
    expect(await getDb().messages.count()).toBe(0)
  })

  it("rejects malformed rows before writing the page", async () => {
    const transport = createTransport(jest.fn(async () => ({ rows: [null], total: 1 }) as never))

    await expect(hydrateSessionHistory(transport, "s1")).rejects.toThrow(
      /invalid session history row/
    )
    expect(await getDb().messages.count()).toBe(0)
  })
})

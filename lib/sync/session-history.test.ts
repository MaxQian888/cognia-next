/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"
import {
  setActiveRuntimeTargetContext,
  clearActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { isMediaRef, parseMediaRef } from "@/lib/db/message-media"
import type { Transport } from "@/lib/tauri/transport-types"

import {
  __resetHydratedSessionHistoryForTests,
  hydrateSessionHistory,
  invalidateSessionHistory,
  getSessionHistoryMode,
} from "./session-history"

function createTransport(call: jest.Mock, capabilities?: { version: number }): Transport {
  return {
    call: (async (method: string, args?: Record<string, unknown>) => {
      if (method === "transcript_capabilities") {
        if (capabilities) return capabilities
        throw Object.assign(new Error("method not found"), { code: "METHOD_NOT_FOUND" })
      }
      return call(method, args)
    }) as Transport["call"],
    subscribe: () => () => {},
  }
}

/** Drain the microtask queue so an in-flight negotiation reaches its first RPC. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe("hydrateSessionHistory", () => {
  beforeEach(async () => {
    __resetHydratedSessionHistoryForTests()
    clearActiveRuntimeTargetContext()
    await getDb().messages.clear()
  })

  it("does not reuse another Host's ownership result for the same session id", async () => {
    const firstHost = createTransport(jest.fn().mockRejectedValue({ code: "SESSION_NOT_FOUND" }), {
      version: 1,
    })
    const secondCall = jest.fn().mockResolvedValue({ items: [] })
    const secondHost = createTransport(secondCall, { version: 1 })
    await hydrateSessionHistory(firstHost, "s1")
    await expect(hydrateSessionHistory(secondHost, "s1")).resolves.toMatchObject({
      mode: "timeline",
    })
    expect(secondCall).toHaveBeenCalledTimes(1)
  })

  it("invalidates completed and pending ownership without accepting stale responses", async () => {
    let resolve: (value: unknown) => void = () => {}
    const call = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
      .mockResolvedValue({ items: [] })
    const transport = createTransport(call, { version: 1 })
    const pending = hydrateSessionHistory(transport, "s1")
    await flush()
    invalidateSessionHistory("s1")
    expect(getSessionHistoryMode("s1")).toBeNull()
    resolve({ items: [] })

    // The stale answer is discarded, and the question it was asking is re-put
    // to the Host rather than reported as a failed transcript load.
    await expect(pending).resolves.toMatchObject({ mode: "timeline" })
    expect(call).toHaveBeenCalledTimes(2)
    expect(getSessionHistoryMode("s1")).toBe("timeline")
  })

  // The reported defect: two `session_history_scope_changed` errors on every
  // web boot, and a chat pane left on an error card with an empty transcript.
  // A companion transport publishes `reconnecting` then `connected` while the
  // first pane is already negotiating, and `watchConnection` invalidates on
  // both — so the negotiation that was going to answer "timeline" died, and
  // nothing re-ran it (the mode the pane subscribes to never left `null`).
  it("re-negotiates when the transport settles its own connection mid-flight", async () => {
    let resolveTimeline: (value: unknown) => void = () => {}
    const call = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolveTimeline = done
          })
      )
      .mockResolvedValue({ items: [] })
    let connectionChanged: (state: string) => void = () => {}
    const transport = {
      ...createTransport(call, { version: 1 }),
      onConnectionStateChange: (listener: (state: string) => void) => {
        connectionChanged = listener
        return jest.fn()
      },
    }

    const pending = hydrateSessionHistory(transport, "s1")
    await flush()
    connectionChanged("reconnecting")
    connectionChanged("connected")
    resolveTimeline({ items: [] })

    await expect(pending).resolves.toEqual({ applied: 0, total: 0, mode: "timeline" })
    expect(getSessionHistoryMode("s1")).toBe("timeline")
  })

  it("keeps a later caller on the same hydration after a supersession", async () => {
    let resolveFirst: (value: unknown) => void = () => {}
    let resolveSecond: (value: unknown) => void = () => {}
    const call = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolveFirst = done
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolveSecond = done
          })
      )
    const transport = createTransport(call, { version: 1 })

    const first = hydrateSessionHistory(transport, "s1")
    await flush()
    invalidateSessionHistory("s1")
    resolveFirst({ items: [] })
    await flush()

    expect(hydrateSessionHistory(transport, "s1")).toBe(first)
    resolveSecond({ items: [] })
    await expect(first).resolves.toMatchObject({ mode: "timeline" })
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("reports failure rather than re-asking forever when nothing settles", async () => {
    let connectionChanged: (state: string) => void = () => {}
    const call = jest.fn(async () => {
      connectionChanged("reconnecting")
      return { items: [] }
    })
    const transport = {
      ...createTransport(call, { version: 1 }),
      onConnectionStateChange: (listener: (state: string) => void) => {
        connectionChanged = listener
        return jest.fn()
      },
    }

    await expect(hydrateSessionHistory(transport, "s1")).rejects.toThrow(
      "session_history_scope_changed"
    )
    expect(call).toHaveBeenCalledTimes(6)
    expect(getSessionHistoryMode("s1")).toBeNull()
  })

  it("scopes ownership by account and routing generation", async () => {
    const call = jest.fn().mockResolvedValue({ items: [] })
    const transport = createTransport(call, { version: 1 })
    setActiveRuntimeTargetContext("acct-history", "host-one", 1)
    await hydrateSessionHistory(transport, "same")
    setActiveRuntimeTargetContext("acct-history", "host-one", 2)
    expect(getSessionHistoryMode("same")).toBeNull()
    await hydrateSessionHistory(transport, "same")
    setActiveRuntimeTargetContext("acct-second", "host-one", 3)
    await hydrateSessionHistory(transport, "same")
    expect(call).toHaveBeenCalledTimes(3)
  })

  it("invalidates remote ownership on reconnect and re-negotiates", async () => {
    const call = jest.fn().mockResolvedValue({ items: [] })
    let connectionChanged: (state: string) => void = () => {}
    const transport = {
      ...createTransport(call, { version: 1 }),
      onConnectionStateChange: (listener: (state: string) => void) => {
        connectionChanged = listener
        return jest.fn()
      },
    }
    await hydrateSessionHistory(transport, "s1")
    connectionChanged("reconnecting")
    expect(getSessionHistoryMode("s1")).toBeNull()
    connectionChanged("connected")
    await hydrateSessionHistory(transport, "s1")
    expect(call).toHaveBeenCalledTimes(2)
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

    expect(outcome).toEqual({ applied: 5, total: 5, mode: "legacy" })
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
    await Promise.resolve()
    await Promise.resolve()
    expect(call).toHaveBeenCalledTimes(1)
    resolvePage?.({ rows: [], total: 0 })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { applied: 0, total: 0, mode: "legacy" },
      { applied: 0, total: 0, mode: "legacy" },
    ])
  })

  it("does not hydrate full history when transcript V1 is available", async () => {
    const hostCall = jest.fn(async () => ({ items: [], revision: 0, hasMore: false }))
    const transport = createTransport(hostCall, { version: 1 })

    await expect(hydrateSessionHistory(transport, "s1")).resolves.toEqual({
      applied: 0,
      total: 0,
      mode: "timeline",
    })
    // One newest turn settles ownership; the legacy pager is never entered.
    expect(hostCall.mock.calls).toEqual([
      ["session_timeline", { session_id: "s1", direction: "backward", limit: 1 }],
    ])
  })

  // The defect: capability was read as ownership, so a conversation this
  // browser created was handed to the host's projection. The host answered
  // that it had no such session and the pane rendered that refusal instead of
  // the transcript sitting in local Dexie.
  it("keeps a session the host has never seen on the local transcript", async () => {
    const hostCall = jest.fn(async () => {
      throw Object.assign(new Error("SESSION_NOT_FOUND"), { code: "SESSION_NOT_FOUND" })
    })
    const transport = createTransport(hostCall, { version: 1 })

    await expect(hydrateSessionHistory(transport, "s1")).resolves.toEqual({
      applied: 0,
      total: 0,
      mode: "local",
    })
    expect(hostCall).toHaveBeenCalledTimes(1)
  })

  // Hosts predating the code-preserving RPC envelope flatten every transcript
  // error into `internal_error` and carry the real code in the message.
  it("reads the protocol code from the message when the envelope drops it", async () => {
    const hostCall = jest.fn(async () => {
      throw Object.assign(new Error("SESSION_NOT_FOUND"), { code: "internal_error" })
    })

    await expect(
      hydrateSessionHistory(createTransport(hostCall, { version: 1 }), "s1")
    ).resolves.toEqual({ applied: 0, total: 0, mode: "local" })
  })

  it("leaves any other timeline refusal visible rather than guessing an owner", async () => {
    const hostCall = jest.fn(async () => {
      throw Object.assign(new Error("INVALID_PARAMS"), { code: "INVALID_PARAMS" })
    })

    await expect(
      hydrateSessionHistory(createTransport(hostCall, { version: 1 }), "s1")
    ).rejects.toThrow("INVALID_PARAMS")
  })

  it("does not downgrade network failures to a legacy full-history read", async () => {
    const legacyCall = jest.fn()
    const transport: Transport = {
      call: jest.fn().mockRejectedValue(new Error("network timeout")) as Transport["call"],
      subscribe: () => () => {},
    }

    await expect(hydrateSessionHistory(transport, "s1")).rejects.toThrow("network timeout")
    expect(legacyCall).not.toHaveBeenCalled()
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
      mode: "legacy",
    })
  })

  it("ingests legacy inline images instead of retaining base64 history rows", async () => {
    const transport = createTransport(
      jest.fn(async () => ({
        rows: [
          {
            id: "image-1",
            sessionId: "s1",
            role: "assistant",
            parts: [
              {
                type: "file",
                url: "data:image/png;base64,aGVsbG8=",
                mediaType: "image/png",
              },
            ],
            createdAt: 1,
          },
        ],
      }))
    )

    await hydrateSessionHistory(transport, "s1")

    const db = getDb()
    const row = await db.messages.get("image-1")
    const ref = (row?.parts[0] as { url?: string } | undefined)?.url
    expect(isMediaRef(ref)).toBe(true)
    await expect(db.messageMediaRefs.get(["image-1", parseMediaRef(ref!)!])).resolves.toMatchObject(
      {
        sessionId: "s1",
      }
    )
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

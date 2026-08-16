/**
 * Long-connection transport tests.
 *
 * The binary protobuf protocol now lives in Rust; this TS layer just opens the
 * Rust handle (`connectorsLarkWsOpen`) and consumes complete event envelopes
 * delivered on `connectors://lark-ws/<handleId>/event`.
 *
 * These drive the SEAM (`setConnectorListen`), not `@tauri-apps/api/event`.
 * That is deliberate: the transport used to import Tauri's `listen` directly,
 * which threw on the headless brain (no `__TAURI_INTERNALS__`) and left an open
 * Feishu socket behind. A test that mocks the Tauri module cannot see that —
 * it stubs out the exact boundary that breaks. Swapping the seam is what the
 * brain does at boot, so exercising the seam is what proves the transport works
 * there.
 *
 * Mocks: connectorsLarkWsOpen, connectorsLarkWsClose, the connectorListen seam.
 * Pattern: open → push /event envelopes → assert yield; abort → handle closed.
 */

import { setConnectorListen, type ConnectorListenFn } from "@/lib/connectors/events"
import { connectorsLarkWsOpen, connectorsLarkWsClose } from "@/lib/connectors/tauri/commands"
import { startLarkLongConn } from "./transport-long-conn"

const mockOpen = connectorsLarkWsOpen as jest.Mock
const mockClose = connectorsLarkWsClose as jest.Mock

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsLarkWsOpen: jest.fn(),
  connectorsLarkWsClose: jest.fn(),
}))

function createFakeWsSession() {
  let eventHandler: ((event: { payload: string }) => void) | null = null
  let closeHandler: (() => void) | null = null
  let listenCallCount = 0
  let handlersResolve: () => void = () => {}
  const handlersReadyP = new Promise<void>((r) => {
    handlersResolve = r
  })

  const listenImpl = jest.fn().mockImplementation(async (eventName: string, handler: unknown) => {
    listenCallCount++
    if ((eventName as string).endsWith("/event")) {
      eventHandler = handler as (event: { payload: string }) => void
    } else if ((eventName as string).endsWith("/close")) {
      closeHandler = handler as () => void
    }
    if (listenCallCount >= 2) handlersResolve()
    return jest.fn()
  })

  return {
    listenImpl,
    waitForListeners: () => handlersReadyP,
    push(envelope: unknown) {
      eventHandler?.({ payload: JSON.stringify(envelope) })
    },
    triggerClose() {
      closeHandler?.()
    },
  }
}

function makeLarkEnvelope(msgId: string) {
  return {
    schema: "2.0",
    header: { event_id: `evt_${msgId}`, event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: "ou_user_001" } },
      message: {
        message_id: msgId,
        chat_id: "oc_chat_001",
        chat_type: "p2p",
        message_type: "text",
        content: '{"text":"hello"}',
      },
    },
  }
}

/** Install a listener behind the seam and restore the default afterwards. */
function installSeam(fn: ConnectorListenFn) {
  const previous = setConnectorListen(fn)
  restoreSeam = () => setConnectorListen(previous)
}
let restoreSeam: (() => void) | null = null

beforeEach(() => {
  jest.clearAllMocks()
  mockOpen.mockResolvedValue("lark-handle-id")
  mockClose.mockResolvedValue(undefined)
})

afterEach(() => {
  restoreSeam?.()
  restoreSeam = null
})

describe("startLarkLongConn", () => {
  it("yields envelopes delivered on the /event channel", async () => {
    const session = createFakeWsSession()
    installSeam(session.listenImpl)

    const ctrl = new AbortController()
    const yielded: string[] = []

    const collectorDone = (async () => {
      for await (const envelope of startLarkLongConn({
        adapterId: "lark-1",
        signal: ctrl.signal,
        _backoffBaseMs: 1,
      })) {
        yielded.push(envelope.event.message!.message_id)
        if (yielded.length >= 2) break
      }
    })()

    await session.waitForListeners()

    session.push(makeLarkEnvelope("om_001"))
    await new Promise((r) => setTimeout(r, 10))
    session.push(makeLarkEnvelope("om_002"))
    await new Promise((r) => setTimeout(r, 10))

    ctrl.abort()
    await collectorDone

    expect(mockOpen).toHaveBeenCalledWith("lark-1")
    expect(yielded).toEqual(["om_001", "om_002"])
  }, 10000)

  it("subscribes through the swappable seam, not Tauri's listen", async () => {
    // The headless brain swaps this seam for a `/ws/events` listener. If the
    // transport ever imports `@tauri-apps/api/event` again, the swapped
    // listener sees nothing and Feishu silently stops delivering on cloud.
    const session = createFakeWsSession()
    installSeam(session.listenImpl)

    const ctrl = new AbortController()
    const collectorDone = (async () => {
      for await (const _ of startLarkLongConn({
        adapterId: "lark-1",
        signal: ctrl.signal,
        _backoffBaseMs: 1,
      })) {
        // drain
      }
    })()

    await session.waitForListeners()
    ctrl.abort()
    await collectorDone

    const topics = session.listenImpl.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(topics).toEqual([
      "connectors://lark-ws/lark-handle-id/event",
      "connectors://lark-ws/lark-handle-id/close",
    ])
  }, 10000)

  it("releases the Rust handle when subscribing rejects", async () => {
    // The regression: `listen` used to be awaited OUTSIDE the try/finally that
    // closes the handle, so a rejection left a live, authenticated,
    // self-reconnecting Feishu socket in Rust with no consumer and no path
    // that would ever close it.
    installSeam(jest.fn().mockRejectedValue(new Error("no __TAURI_INTERNALS__")))

    const ctrl = new AbortController()
    await expect(
      (async () => {
        for await (const _ of startLarkLongConn({
          adapterId: "lark-1",
          signal: ctrl.signal,
          _backoffBaseMs: 1,
        })) {
          // unreachable
        }
      })()
    ).rejects.toThrow("no __TAURI_INTERNALS__")

    expect(mockOpen).toHaveBeenCalledWith("lark-1")
    expect(mockClose).toHaveBeenCalledWith("lark-handle-id")
  }, 10000)

  it("releases the Rust handle when the second subscribe rejects", async () => {
    // Half-subscribed is the nastier variant: the /event listener is live, so
    // the failure looks like a working connection right up until nothing
    // arrives.
    let call = 0
    installSeam(
      jest.fn().mockImplementation(async () => {
        call += 1
        if (call === 1) return jest.fn()
        throw new Error("close-channel subscribe failed")
      })
    )

    const ctrl = new AbortController()
    await expect(
      (async () => {
        for await (const _ of startLarkLongConn({
          adapterId: "lark-1",
          signal: ctrl.signal,
          _backoffBaseMs: 1,
        })) {
          // unreachable
        }
      })()
    ).rejects.toThrow("close-channel subscribe failed")

    expect(mockClose).toHaveBeenCalledWith("lark-handle-id")
  }, 10000)

  it("closes the Rust handle when the signal aborts", async () => {
    const session = createFakeWsSession()
    installSeam(session.listenImpl)

    const ctrl = new AbortController()

    const collectorDone = (async () => {
      for await (const _ of startLarkLongConn({
        adapterId: "lark-1",
        signal: ctrl.signal,
        _backoffBaseMs: 1,
      })) {
        // drain
      }
    })()

    await session.waitForListeners()
    ctrl.abort()
    await collectorDone

    expect(mockClose).toHaveBeenCalledWith("lark-handle-id")
  }, 10000)

  it("ignores malformed (non-JSON) event payloads", async () => {
    const session = createFakeWsSession()
    installSeam(session.listenImpl)

    const ctrl = new AbortController()
    const yielded: string[] = []

    const collectorDone = (async () => {
      for await (const envelope of startLarkLongConn({
        adapterId: "lark-1",
        signal: ctrl.signal,
        _backoffBaseMs: 1,
      })) {
        yielded.push(envelope.event.message!.message_id)
        if (yielded.length >= 1) break
      }
    })()

    await session.waitForListeners()

    // Malformed frame must not throw or yield.
    const handler = (session.listenImpl.mock.calls.find((c: unknown[]) =>
      (c[0] as string).endsWith("/event")
    )?.[1] ?? (() => {})) as (e: { payload: string }) => void
    handler({ payload: "<not json>" })
    await new Promise((r) => setTimeout(r, 10))
    session.push(makeLarkEnvelope("om_ok"))
    await new Promise((r) => setTimeout(r, 10))

    ctrl.abort()
    await collectorDone

    expect(yielded).toEqual(["om_ok"])
  }, 10000)

  it("stops immediately when the signal is pre-aborted", async () => {
    installSeam(jest.fn().mockResolvedValue(jest.fn()))

    const ctrl = new AbortController()
    ctrl.abort()

    const collected: unknown[] = []
    for await (const e of startLarkLongConn({
      adapterId: "lark-1",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })) {
      collected.push(e)
    }

    expect(collected).toHaveLength(0)
    expect(mockOpen).not.toHaveBeenCalled()
  })
})

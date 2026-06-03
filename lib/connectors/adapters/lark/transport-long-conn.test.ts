/**
 * Long-connection transport tests.
 *
 * The binary protobuf protocol now lives in Rust; this TS layer just opens the
 * Rust handle (`connectorsLarkWsOpen`) and consumes complete event envelopes
 * delivered on `connectors://lark-ws/<handleId>/event`.
 *
 * Mocks: connectorsLarkWsOpen, connectorsLarkWsClose, @tauri-apps/api/event listen.
 * Pattern: open → push /event envelopes → assert yield; abort → handle closed.
 */

import { listen } from "@tauri-apps/api/event"
import { connectorsLarkWsOpen, connectorsLarkWsClose } from "@/lib/connectors/tauri/commands"
import { startLarkLongConn } from "./transport-long-conn"

const mockListen = listen as jest.Mock
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

beforeEach(() => {
  jest.clearAllMocks()
  mockOpen.mockResolvedValue("lark-handle-id")
  mockClose.mockResolvedValue(undefined)
})

describe("startLarkLongConn", () => {
  it("yields envelopes delivered on the /event channel", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

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

  it("closes the Rust handle when the signal aborts", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

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
    mockListen.mockImplementation(session.listenImpl)

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
    mockListen.mockResolvedValue(jest.fn())

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

import { listen } from "@tauri-apps/api/event"
import { startLarkWebhookTransport } from "./transport-webhook"
import type { LarkEventEnvelope } from "./parse"

const mockListen = listen as jest.Mock

function makeEnvelope(msgId: string): LarkEventEnvelope {
  return {
    schema: "2.0",
    header: {
      event_id: `evt_${msgId}`,
      event_type: "im.message.receive_v1",
      app_id: "cli_app_001",
    },
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

describe("startLarkWebhookTransport", () => {
  beforeEach(() => {
    mockListen.mockReset()
  })

  it("does not subscribe when already aborted", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const gen = startLarkWebhookTransport({ adapterId: "lark-aborted", signal: ctrl.signal })
    await expect(gen.next()).resolves.toEqual({ done: true, value: undefined })
    expect(mockListen).not.toHaveBeenCalled()
  })

  it("disposes a subscription that resolves after abort without hanging", async () => {
    const ctrl = new AbortController()
    const unlisten = jest.fn()
    let finishRegistration!: (value: () => void) => void
    mockListen.mockReturnValue(
      new Promise<() => void>((resolve) => {
        finishRegistration = resolve
      })
    )
    const gen = startLarkWebhookTransport({ adapterId: "lark-pending", signal: ctrl.signal })
    const pending = gen.next()
    ctrl.abort()
    finishRegistration(unlisten)
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    expect(unlisten).toHaveBeenCalledTimes(1)
    ctrl.abort()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it("subscribes to the correct event channel", async () => {
    const ctrl = new AbortController()

    mockListen.mockImplementation(async () => jest.fn())

    const gen = startLarkWebhookTransport({ adapterId: "lark-1", signal: ctrl.signal })
    const iterPromise = gen.next()

    await Promise.resolve()
    expect(mockListen).toHaveBeenCalledWith("connectors://webhook/lark-1", expect.any(Function))

    ctrl.abort()
    await iterPromise
  })

  it("yields envelopes pushed via the event listener", async () => {
    const ctrl = new AbortController()
    let listenerFn: ((e: { payload: LarkEventEnvelope }) => void) | null = null
    const unlistenMock = jest.fn()

    mockListen.mockImplementation(async (_eventName: string, fn: unknown) => {
      listenerFn = fn as (e: { payload: LarkEventEnvelope }) => void
      return unlistenMock
    })

    const collected: string[] = []

    const iterPromise = (async () => {
      for await (const env of startLarkWebhookTransport({
        adapterId: "lark-2",
        signal: ctrl.signal,
      })) {
        collected.push(env.event.message!.message_id)
        if (collected.length >= 2) {
          ctrl.abort()
          break
        }
      }
    })()

    await Promise.resolve()
    await Promise.resolve()

    listenerFn!({ payload: makeEnvelope("om_001") })
    listenerFn!({ payload: makeEnvelope("om_002") })

    await iterPromise

    expect(collected).toEqual(["om_001", "om_002"])
  })

  it("stops cleanly when signal is aborted", async () => {
    const ctrl = new AbortController()
    const unlistenMock = jest.fn()

    mockListen.mockImplementation(async () => unlistenMock)

    const iterPromise = (async () => {
      const results: string[] = []
      for await (const env of startLarkWebhookTransport({
        adapterId: "lark-3",
        signal: ctrl.signal,
      })) {
        results.push(env.event.message!.message_id)
      }
      return results
    })()

    await Promise.resolve()
    await Promise.resolve()
    ctrl.abort()

    const results = await iterPromise
    expect(results).toHaveLength(0)
    expect(unlistenMock).toHaveBeenCalled()
  })
})

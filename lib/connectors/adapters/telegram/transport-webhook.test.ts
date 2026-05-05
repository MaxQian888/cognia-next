import { listen } from "@tauri-apps/api/event"
import { startWebhookTransport } from "./transport-webhook"

const mockListen = listen as jest.Mock

function makeUpdate(id: number) {
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: 111, first_name: "Test" },
      chat: { id: 111, type: "private" as const },
      date: 1000000,
      text: `msg ${id}`,
    },
  }
}

describe("startWebhookTransport", () => {
  beforeEach(() => {
    mockListen.mockReset()
  })

  it("subscribes to the correct event channel", async () => {
    const ctrl = new AbortController()
    let _listenerFn: ((e: { payload: unknown }) => void) | null = null

    mockListen.mockImplementation(async (_eventName, fn) => {
      _listenerFn = fn
      void _listenerFn
      return jest.fn() // unlisten
    })

    // Start consuming and immediately abort
    const gen = startWebhookTransport({ adapterId: "tg-1", signal: ctrl.signal })
    const iterPromise = gen.next()

    // Verify listen was called with the right channel name
    await Promise.resolve()
    expect(mockListen).toHaveBeenCalledWith("connectors://webhook/tg-1", expect.any(Function))

    ctrl.abort()
    await iterPromise
  })

  it("yields updates pushed via the event listener", async () => {
    const ctrl = new AbortController()
    let listenerFn: ((e: { payload: unknown }) => void) | null = null
    const unlistenMock = jest.fn()

    mockListen.mockImplementation(async (_eventName, fn) => {
      listenerFn = fn
      return unlistenMock
    })

    const updates: number[] = []

    const iterPromise = (async () => {
      for await (const u of startWebhookTransport({ adapterId: "tg-2", signal: ctrl.signal })) {
        updates.push(u.update_id)
        if (updates.length >= 2) {
          ctrl.abort()
          break
        }
      }
    })()

    // Wait for listen to be called
    await Promise.resolve()
    await Promise.resolve()

    // Push 2 updates via the listener
    listenerFn!({ payload: makeUpdate(10) })
    listenerFn!({ payload: makeUpdate(20) })

    await iterPromise

    expect(updates).toEqual([10, 20])
  })

  it("stops cleanly when signal is aborted", async () => {
    const ctrl = new AbortController()
    const unlistenMock = jest.fn()

    mockListen.mockImplementation(async (_eventName, _fn) => {
      return unlistenMock
    })

    const iterPromise = (async () => {
      const results: number[] = []
      for await (const u of startWebhookTransport({ adapterId: "tg-3", signal: ctrl.signal })) {
        results.push(u.update_id)
      }
      return results
    })()

    // Abort immediately after subscribing
    await Promise.resolve()
    await Promise.resolve()
    ctrl.abort()

    const results = await iterPromise
    expect(results).toHaveLength(0)
    expect(unlistenMock).toHaveBeenCalled()
  })
})

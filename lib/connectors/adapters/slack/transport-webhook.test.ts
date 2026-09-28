jest.mock("@/lib/connectors/events", () => ({ connectorListen: jest.fn() }))
import { connectorListen as listen } from "@/lib/connectors/events"
import { startSlackWebhookTransport } from "./transport-webhook"
import type { SlackEventEnvelope } from "./parse"

const mockListen = listen as jest.Mock

function makeEnvelope(ts: string): SlackEventEnvelope {
  return {
    type: "event_callback",
    event: {
      type: "message",
      channel: "C111",
      user: "U222",
      text: "hello",
      ts,
    },
  }
}

describe("startSlackWebhookTransport", () => {
  beforeEach(() => {
    mockListen.mockReset()
  })

  it("does not register an already-aborted subscription", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const gen = startSlackWebhookTransport({ adapterId: "sl-cancelled", signal: ctrl.signal })
    await expect(gen.next()).resolves.toEqual({ done: true, value: undefined })
    expect(mockListen).not.toHaveBeenCalled()
  })

  it("releases a subscription that finishes registering after abort", async () => {
    const ctrl = new AbortController()
    const unlisten = jest.fn()
    let finishRegistration!: (value: () => void) => void
    mockListen.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          finishRegistration = resolve
        })
    )
    const gen = startSlackWebhookTransport({ adapterId: "sl-race", signal: ctrl.signal })
    const pending = gen.next()
    ctrl.abort()
    finishRegistration(unlisten)
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it("subscribes to the correct event channel", async () => {
    const ctrl = new AbortController()
    mockListen.mockImplementation(async () => jest.fn())

    const gen = startSlackWebhookTransport({ adapterId: "slack-1", signal: ctrl.signal })
    const iterPromise = gen.next()

    await Promise.resolve()
    expect(mockListen).toHaveBeenCalledWith("connectors://webhook/slack-1", expect.any(Function))

    ctrl.abort()
    await iterPromise
  })

  it("yields envelopes pushed via the event listener", async () => {
    const ctrl = new AbortController()
    let listenerFn: ((e: { payload: SlackEventEnvelope }) => void) | null = null
    const unlistenMock = jest.fn()

    mockListen.mockImplementation(async (_eventName: string, fn: unknown) => {
      listenerFn = fn as (e: { payload: SlackEventEnvelope }) => void
      return unlistenMock
    })

    const collected: string[] = []
    const iterPromise = (async () => {
      for await (const env of startSlackWebhookTransport({
        adapterId: "slack-2",
        signal: ctrl.signal,
      })) {
        collected.push(env.event.ts)
        if (collected.length >= 2) {
          ctrl.abort()
          break
        }
      }
    })()

    await Promise.resolve()
    await Promise.resolve()

    listenerFn!({ payload: makeEnvelope("1.111") })
    listenerFn!({ payload: makeEnvelope("2.222") })

    await iterPromise

    expect(collected).toEqual(["1.111", "2.222"])
  })

  it("stops cleanly when the signal is aborted before any event arrives", async () => {
    const ctrl = new AbortController()
    const unlistenMock = jest.fn()
    mockListen.mockImplementation(async () => unlistenMock)

    const iterPromise = (async () => {
      const results: string[] = []
      for await (const env of startSlackWebhookTransport({
        adapterId: "slack-3",
        signal: ctrl.signal,
      })) {
        results.push(env.event.ts)
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

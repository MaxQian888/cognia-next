import { listen } from "@tauri-apps/api/event"
import { startWebhookTransport } from "./transport-webhook"

const mockListen = listen as jest.Mock

type Handler = (e: { payload: unknown }) => void

function captureListener(): { get: () => Handler; unlisten: jest.Mock; names: string[] } {
  let handler: Handler | null = null
  const unlisten = jest.fn()
  const names: string[] = []
  mockListen.mockImplementation(async (name: string, h: unknown) => {
    names.push(name)
    handler = h as Handler
    return unlisten
  })
  return { get: () => handler!, unlisten, names }
}

describe("startWebhookTransport (qq-official)", () => {
  beforeEach(() => mockListen.mockReset())

  it("subscribes to connectors://webhook/<adapterId> and yields op-0 dispatch envelopes", async () => {
    const cap = captureListener()
    const ctrl = new AbortController()
    const gen = startWebhookTransport({ adapterId: "qq-1", signal: ctrl.signal })

    const out: Array<{ t: string }> = []
    const collector = (async () => {
      for await (const d of gen) {
        out.push(d)
        if (out.length >= 2) ctrl.abort()
      }
    })()

    await new Promise((r) => setTimeout(r, 5))
    expect(cap.names).toEqual(["connectors://webhook/qq-1"])
    cap.get()({
      payload: { op: 0, t: "C2C_MESSAGE_CREATE", d: { id: "m1", author: { user_openid: "U" } } },
    })
    cap.get()({
      payload: { op: 0, t: "GROUP_AT_MESSAGE_CREATE", d: { id: "m2", group_openid: "GO" } },
    })
    await collector

    expect(out.map((d) => d.t)).toEqual(["C2C_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE"])
    expect(cap.unlisten).toHaveBeenCalledTimes(1)
  })

  it("drops non-dispatch payloads (op-13 validation, heartbeats, garbage) and stops on abort", async () => {
    const cap = captureListener()
    const ctrl = new AbortController()
    const gen = startWebhookTransport({ adapterId: "qq-1", signal: ctrl.signal })
    const out: unknown[] = []
    const collector = (async () => {
      for await (const d of gen) out.push(d)
    })()
    await new Promise((r) => setTimeout(r, 5))
    cap.get()({ payload: { op: 13, d: { plain_token: "x", event_ts: "1" } } })
    cap.get()({ payload: { op: 11 } })
    cap.get()({ payload: { op: 0 } })
    cap.get()({ payload: "not-an-object" })
    cap.get()({ payload: null })
    ctrl.abort()
    await collector
    expect(out).toHaveLength(0)
    expect(cap.unlisten).toHaveBeenCalledTimes(1)
  })

  it("drains envelopes queued before abort, then ends", async () => {
    const cap = captureListener()
    const ctrl = new AbortController()
    const gen = startWebhookTransport({ adapterId: "qq-1", signal: ctrl.signal })
    const out: string[] = []
    const collector = (async () => {
      for await (const d of gen) out.push(d.t)
    })()
    await new Promise((r) => setTimeout(r, 5))
    // Two envelopes land in the same tick as the abort — both must still be
    // delivered before the generator ends.
    cap.get()({ payload: { op: 0, t: "AT_MESSAGE_CREATE", d: { id: "a" } } })
    cap.get()({ payload: { op: 0, t: "DIRECT_MESSAGE_CREATE", d: { id: "b" } } })
    ctrl.abort()
    await collector
    expect(out).toEqual(["AT_MESSAGE_CREATE", "DIRECT_MESSAGE_CREATE"])
  })

  it("an early consumer break unsubscribes the listener", async () => {
    const cap = captureListener()
    const ctrl = new AbortController()
    const gen = startWebhookTransport({ adapterId: "qq-1", signal: ctrl.signal })
    const first = gen.next()
    await new Promise((r) => setTimeout(r, 5))
    cap.get()({ payload: { op: 0, t: "C2C_MESSAGE_CREATE", d: { id: "m1" } } })
    expect((await first).value?.t).toBe("C2C_MESSAGE_CREATE")
    await gen.return(undefined)
    expect(cap.unlisten).toHaveBeenCalledTimes(1)
  })
})

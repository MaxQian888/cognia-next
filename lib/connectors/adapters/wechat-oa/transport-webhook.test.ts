import { listen } from "@tauri-apps/api/event"
import { startWechatOaWebhook } from "./transport-webhook"
import { invoke } from "@tauri-apps/api/core"

const mockListen = listen as jest.Mock
const mockInvoke = invoke as jest.Mock

describe("startWechatOaWebhook", () => {
  beforeEach(() => {
    mockListen.mockReset()
    mockInvoke.mockReset().mockResolvedValue([])
  })

  it("recovers an initial journal read failure without closing the subscription", async () => {
    jest.useFakeTimers()
    const ctrl = new AbortController()
    const unlisten = jest.fn()
    mockListen.mockResolvedValue(unlisten)
    mockInvoke
      .mockRejectedValueOnce(new Error("temporary inbox read failure"))
      .mockResolvedValueOnce([{ id: "recovered", xml: "<xml>retained</xml>", receivedAt: 1 }])
    const gen = startWechatOaWebhook({ adapterId: "oa", signal: ctrl.signal })
    let delivered: unknown
    let failure: unknown
    const pending = gen.next().then(
      (value) => {
        delivered = value
      },
      (error) => {
        failure = error
      }
    )
    try {
      await jest.advanceTimersByTimeAsync(0)
      expect(failure).toBeUndefined()
      expect(unlisten).not.toHaveBeenCalled()
      expect(mockInvoke).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(249)
      expect(mockInvoke).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(1)
      expect(delivered).toEqual({
        done: false,
        value: { xml: "<xml>retained</xml>", ingressId: "recovered" },
      })
      expect(mockInvoke).toHaveBeenCalledTimes(2)
    } finally {
      ctrl.abort()
      await pending
      await gen.return(undefined)
      jest.useRealTimers()
    }
  })

  it("reconciles a journal-only arrival while idle even without a live notification", async () => {
    jest.useFakeTimers()
    const ctrl = new AbortController()
    mockListen.mockResolvedValue(jest.fn())
    mockInvoke
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "silent", xml: "<xml>retained</xml>", receivedAt: 1 }])
    const gen = startWechatOaWebhook({ adapterId: "oa", signal: ctrl.signal })
    let delivered: unknown
    const pending = gen.next().then((value) => {
      delivered = value
    })
    try {
      await jest.advanceTimersByTimeAsync(29_999)
      expect(mockInvoke).toHaveBeenCalledTimes(1)
      expect(delivered).toBeUndefined()
      await jest.advanceTimersByTimeAsync(1)
      expect(delivered).toEqual({
        done: false,
        value: { xml: "<xml>retained</xml>", ingressId: "silent" },
      })
      expect(mockInvoke).toHaveBeenCalledTimes(2)
    } finally {
      ctrl.abort()
      await pending
      await gen.return(undefined)
      jest.useRealTimers()
    }
  })

  it("bounds journal read retries and stops the retry timer on abort", async () => {
    jest.useFakeTimers()
    const ctrl = new AbortController()
    const unlisten = jest.fn()
    mockListen.mockResolvedValue(unlisten)
    mockInvoke.mockRejectedValue(new Error("inbox offline"))
    const gen = startWechatOaWebhook({ adapterId: "oa", signal: ctrl.signal })
    const pending = gen.next()
    try {
      await jest.advanceTimersByTimeAsync(0)
      expect(mockInvoke).toHaveBeenCalledTimes(1)
      for (const delay of [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000])
        await jest.advanceTimersByTimeAsync(delay)
      expect(mockInvoke).toHaveBeenCalledTimes(8)
      expect(jest.getTimerCount()).toBe(1)
      await jest.advanceTimersByTimeAsync(29_999)
      expect(mockInvoke).toHaveBeenCalledTimes(8)
      await jest.advanceTimersByTimeAsync(1)
      expect(mockInvoke).toHaveBeenCalledTimes(9)
      ctrl.abort()
      expect(await pending).toEqual({ done: true, value: undefined })
      expect(unlisten).toHaveBeenCalledTimes(1)
      expect(jest.getTimerCount()).toBe(0)
      await jest.advanceTimersByTimeAsync(60_000)
      expect(mockInvoke).toHaveBeenCalledTimes(9)
    } finally {
      ctrl.abort()
      await gen.return(undefined)
      jest.useRealTimers()
    }
  })

  it("cancels the idle reconciliation timer on live wake and releases it on abort", async () => {
    jest.useFakeTimers()
    const ctrl = new AbortController()
    let handler!: (event: { payload: { xml: string; ingressId: string } }) => void
    mockListen.mockImplementation(async (_name, callback) => {
      handler = callback
      return jest.fn()
    })
    const gen = startWechatOaWebhook({ adapterId: "oa", signal: ctrl.signal })
    const first = gen.next()
    try {
      await jest.advanceTimersByTimeAsync(1_000)
      expect(jest.getTimerCount()).toBe(1)
      mockInvoke.mockResolvedValueOnce([{ id: "live", xml: "<xml>live</xml>", receivedAt: 1 }])
      handler({ payload: { xml: "<xml>live</xml>", ingressId: "live" } })
      expect(await first).toEqual({
        done: false,
        value: { xml: "<xml>live</xml>", ingressId: "live" },
      })
      expect(jest.getTimerCount()).toBe(0)
      const next = gen.next()
      await jest.advanceTimersByTimeAsync(0)
      expect(jest.getTimerCount()).toBe(1)
      ctrl.abort()
      expect(await next).toEqual({ done: true, value: undefined })
      expect(jest.getTimerCount()).toBe(0)
      await jest.advanceTimersByTimeAsync(60_000)
      expect(mockInvoke).toHaveBeenCalledTimes(2)
    } finally {
      ctrl.abort()
      await gen.return(undefined)
      jest.useRealTimers()
    }
  })

  it("finishes without subscribing when already aborted", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const gen = startWechatOaWebhook({ adapterId: "oa", signal: ctrl.signal })
    expect(await gen.next()).toEqual({ done: true, value: undefined })
    expect(mockListen).not.toHaveBeenCalled()
  })

  it("releases a listener whose registration finishes after abort", async () => {
    let register!: (release: () => void) => void
    const registered = new Promise<() => void>((resolve) => {
      register = resolve
    })
    mockListen.mockReturnValueOnce(registered)
    const ctrl = new AbortController()
    const gen = startWechatOaWebhook({ adapterId: "oa", signal: ctrl.signal })
    const pending = gen.next()
    await Promise.resolve()
    ctrl.abort()
    const unlisten = jest.fn()
    register(unlisten)
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it("yields decrypted xml payloads and stops on abort", async () => {
    let handler: ((e: { payload: { xml?: string } }) => void) | null = null
    mockListen.mockImplementation(async (_name: string, h: unknown) => {
      handler = h as (e: { payload: { xml?: string } }) => void
      return jest.fn()
    })

    const ctrl = new AbortController()
    const gen = startWechatOaWebhook({ adapterId: "wxoa-1", signal: ctrl.signal })

    const out: string[] = []
    const collector = (async () => {
      for await (const xml of gen) {
        out.push(xml.xml)
        if (out.length >= 1) ctrl.abort()
      }
    })()

    // Wait for the listener to register.
    await new Promise((r) => setTimeout(r, 5))
    handler!({ payload: { xml: "<xml>hi</xml>" } })
    await collector

    expect(out).toEqual(["<xml>hi</xml>"])
  })

  it("ignores payloads without an xml string", async () => {
    let handler: ((e: { payload: { xml?: string } }) => void) | null = null
    mockListen.mockImplementation(async (_name: string, h: unknown) => {
      handler = h as (e: { payload: { xml?: string } }) => void
      return jest.fn()
    })
    const ctrl = new AbortController()
    const gen = startWechatOaWebhook({ adapterId: "wxoa-1", signal: ctrl.signal })
    const out: string[] = []
    const collector = (async () => {
      for await (const xml of gen) out.push(xml.xml)
    })()
    await new Promise((r) => setTimeout(r, 5))
    handler!({ payload: {} })
    ctrl.abort()
    await collector
    expect(out).toHaveLength(0)
  })

  it("subscribes before recovery and delivers the same live/drained ingress only once", async () => {
    let handler!: (event: { payload: { xml: string; ingressId: string } }) => void
    mockListen.mockImplementation(async (_name, callback) => {
      handler = callback
      return jest.fn()
    })
    let release!: (rows: unknown[]) => void
    mockInvoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const ctrl = new AbortController()
    const gen = startWechatOaWebhook({ adapterId: "oa", signal: ctrl.signal })
    const first = gen.next()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(handler).toBeDefined()
    handler({ payload: { xml: "<xml>same</xml>", ingressId: "2" } })
    release([
      { id: "1", xml: "<xml>older</xml>", receivedAt: 1 },
      { id: "2", xml: "<xml>same</xml>", receivedAt: 2 },
    ])
    expect(await first).toEqual({ done: false, value: { xml: "<xml>older</xml>", ingressId: "1" } })
    expect(await gen.next()).toEqual({
      done: false,
      value: { xml: "<xml>same</xml>", ingressId: "2" },
    })
    ctrl.abort()
    expect(await gen.next()).toEqual({ done: true, value: undefined })
    expect(mockInvoke).toHaveBeenCalledWith("connectors_wechat_oa_inbound_list", {
      adapterId: "oa",
    })
  })

  it("does not resurrect a buffered notification absent from the authoritative inbox", async () => {
    jest.useFakeTimers()
    const ctrl = new AbortController()
    let handler!: (event: { payload: { xml: string; ingressId: string } }) => void
    mockListen.mockImplementation(async (_name, callback) => {
      handler = callback
      return jest.fn()
    })
    let release!: (rows: unknown[]) => void
    mockInvoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const gen = startWechatOaWebhook({ adapterId: "oa", signal: ctrl.signal })
    let delivered: unknown
    const first = gen.next().then((value) => {
      delivered = value
    })
    try {
      await jest.advanceTimersByTimeAsync(0)
      // Retention was cleared by revocation before the outstanding list
      // completed; the old event notification is still in the JS buffer.
      handler({ payload: { xml: "<xml>obsolete</xml>", ingressId: "old" } })
      release([])
      await jest.advanceTimersByTimeAsync(0)
      expect(delivered).toBeUndefined()
      mockInvoke.mockResolvedValue([{ id: "fresh", xml: "<xml>fresh</xml>", receivedAt: 2 }])
      handler({ payload: { xml: "<xml>untrusted live body</xml>", ingressId: "fresh" } })
      await jest.advanceTimersByTimeAsync(0)
      expect(delivered).toEqual({
        done: false,
        value: { xml: "<xml>fresh</xml>", ingressId: "fresh" },
      })
    } finally {
      ctrl.abort()
      await first
      await gen.return(undefined)
      jest.useRealTimers()
    }
  })

  it("immediately rereads a new arrival absent from an in-flight inbox snapshot", async () => {
    jest.useFakeTimers()
    const ctrl = new AbortController()
    let handler!: (event: { payload: { xml: string; ingressId: string } }) => void
    mockListen.mockImplementation(async (_name, callback) => {
      handler = callback
      return jest.fn()
    })
    let release!: (rows: unknown[]) => void
    mockInvoke
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          })
      )
      .mockResolvedValue([{ id: "new", xml: "<xml>retained</xml>", receivedAt: 1 }])
    const gen = startWechatOaWebhook({ adapterId: "oa", signal: ctrl.signal })
    let delivered: unknown
    const pending = gen.next().then((value) => {
      delivered = value
    })
    try {
      await jest.advanceTimersByTimeAsync(0)
      handler({ payload: { xml: "<xml>notification</xml>", ingressId: "new" } })
      release([])
      await jest.advanceTimersByTimeAsync(1)
      expect(mockInvoke).toHaveBeenCalledTimes(2)
      expect(delivered).toEqual({
        done: false,
        value: { xml: "<xml>retained</xml>", ingressId: "new" },
      })
    } finally {
      ctrl.abort()
      await pending
      await gen.return(undefined)
      jest.useRealTimers()
    }
  })

  it("propagates durable native admission state for claimed restart replay", async () => {
    mockListen.mockResolvedValue(jest.fn())
    mockInvoke.mockResolvedValue([
      { id: "claimed", xml: "<xml>retained</xml>", receivedAt: 1, admitted: true },
    ])
    const ctrl = new AbortController()
    const gen = startWechatOaWebhook({ adapterId: "oa", signal: ctrl.signal })
    try {
      expect(await gen.next()).toEqual({
        done: false,
        value: { xml: "<xml>retained</xml>", ingressId: "claimed", admitted: true },
      })
    } finally {
      ctrl.abort()
      await gen.return(undefined)
    }
  })
})

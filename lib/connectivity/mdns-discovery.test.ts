/**
 * @jest-environment jsdom
 */
import { startBroadcast, stopBroadcast, subscribe, type DiscoveredService } from "./mdns-discovery"

describe("subscribe", () => {
  it("dispatches discovered services to handler", async () => {
    const remove = jest.fn()
    let registered: ((svc: DiscoveredService) => void) | null = null
    const startScan = jest.fn().mockResolvedValue(undefined)
    const stopScan = jest.fn().mockResolvedValue(undefined)
    const seen: DiscoveredService[] = []
    const unsub = await subscribe(
      (s) => seen.push(s),
      async () => ({
        startScan,
        stopScan,
        addListener: async (_event: string, h: (svc: DiscoveredService) => void) => {
          registered = h
          return { remove }
        },
      })
    )
    expect(startScan).toHaveBeenCalledWith({ serviceType: "_cognia._tcp" })
    registered!({
      name: "cognia-X",
      hostname: "cognia-X.local",
      ip: "192.168.1.10",
      port: 7891,
      txt: { ver: "0.1.0", fp: "abcd" },
    })
    expect(seen).toHaveLength(1)
    await unsub()
    expect(stopScan).toHaveBeenCalled()
    expect(remove).toHaveBeenCalled()
  })

  it("returns no-op unsub when plugin missing", async () => {
    const unsub = await subscribe(jest.fn(), async () => {
      throw new Error("not native")
    })
    expect(typeof unsub).toBe("function")
  })

  it("returns no-op unsub and releases resources when startScan throws", async () => {
    const stopScan = jest.fn().mockResolvedValue(undefined)
    const remove = jest.fn()
    const unsub = await subscribe(jest.fn(), async () => ({
      startScan: jest.fn().mockRejectedValue(new Error("permission")),
      stopScan,
      addListener: async () => ({ remove }),
    }))
    expect(typeof unsub).toBe("function")
    expect(stopScan).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
  })
})

describe("default native zeroconf adapter", () => {
  afterEach(() => {
    delete (window as { Capacitor?: unknown }).Capacitor
  })

  function plugin() {
    const callbacks: Array<(r?: unknown) => void> = []
    const watch = jest.fn(async (_options, callback) => {
      callbacks.push(callback)
      callback()
      return "watch-id"
    })
    const unwatch = jest.fn(async () => {})
    ;(window as unknown as { Capacitor: unknown }).Capacitor = {
      Plugins: { ZeroConf: { watch, unwatch } },
    }
    return { watch, unwatch, callbacks }
  }
  const resolved = {
    action: "resolved",
    service: {
      name: "desktop",
      hostname: "desktop.local",
      ipv4Addresses: ["192.168.1.10"],
      port: 27890,
      txtRecord: { fp: "abcd" },
    },
  }

  it("uses the native watch callback and a fully qualified service type", async () => {
    const p = plugin()
    const handler = jest.fn()
    const stop = await subscribe(handler)
    expect(p.watch).toHaveBeenCalledWith(
      { type: "_cognia._tcp.", domain: "local." },
      expect.any(Function)
    )
    expect(handler).not.toHaveBeenCalled()
    p.callbacks[0]({ action: "added", service: {} })
    p.callbacks[0](resolved)
    expect(handler).toHaveBeenCalledWith({
      name: "desktop",
      hostname: "desktop.local",
      ip: "192.168.1.10",
      port: 27890,
      txt: { fp: "abcd" },
    })
    await stop()
    p.callbacks[0](resolved)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(p.unwatch).toHaveBeenCalledWith({ type: "_cognia._tcp.", domain: "local." })
  })

  it("shares one watch and keeps it alive until the final subscriber stops", async () => {
    const p = plugin()
    const first = jest.fn(),
      second = jest.fn()
    const [stopFirst, stopSecond] = await Promise.all([subscribe(first), subscribe(second)])
    expect(p.watch).toHaveBeenCalledTimes(1)
    await stopFirst()
    expect(p.unwatch).not.toHaveBeenCalled()
    p.callbacks[0](resolved)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    await stopSecond()
    expect(p.unwatch).toHaveBeenCalledTimes(1)
    const next = jest.fn()
    const stopNext = await subscribe(next)
    expect(p.watch).toHaveBeenCalledTimes(2)
    p.callbacks[0](resolved)
    expect(next).not.toHaveBeenCalled()
    p.callbacks[1](resolved)
    expect(next).toHaveBeenCalledTimes(1)
    await stopNext()
  })

  it("cleans a failed watch and permits retry", async () => {
    const p = plugin()
    p.watch.mockRejectedValueOnce(new Error("cannot browse"))
    await subscribe(jest.fn())
    expect(p.unwatch).toHaveBeenCalledTimes(1)
    const stop = await subscribe(jest.fn())
    expect(p.watch).toHaveBeenCalledTimes(2)
    await stop()
  })
})

describe("startBroadcast / stopBroadcast", () => {
  it("invokes companion_mdns_start with full options", async () => {
    const invoke = jest.fn().mockResolvedValue("cognia-X._cognia._tcp.local.")
    const out = await startBroadcast(
      {
        port: 7891,
        appVersion: "0.1.0",
        tlsFingerprint: "deadbeef",
        instanceName: "cognia-X",
      },
      async () => ({ invoke })
    )
    expect(invoke).toHaveBeenCalledWith("companion_mdns_start", {
      port: 7891,
      appVersion: "0.1.0",
      tlsFingerprint: "deadbeef",
      instanceName: "cognia-X",
    })
    expect(out).toEqual({
      kind: "started",
      fullname: "cognia-X._cognia._tcp.local.",
    })
  })

  it("returns unsupported when not in Tauri", async () => {
    const out = await startBroadcast(
      { port: 1, appVersion: "0", tlsFingerprint: "x" },
      async () => null
    )
    expect(out).toEqual({ kind: "unsupported" })
  })

  it("returns error when invoke throws", async () => {
    const invoke = jest.fn().mockRejectedValue(new Error("rust panic"))
    const out = await startBroadcast(
      { port: 1, appVersion: "0", tlsFingerprint: "x" },
      async () => ({ invoke })
    )
    expect(out).toEqual({ kind: "error", message: "rust panic" })
  })

  it("stopBroadcast calls companion_mdns_stop", async () => {
    const invoke = jest.fn().mockResolvedValue(undefined)
    const out = await stopBroadcast(async () => ({ invoke }))
    expect(invoke).toHaveBeenCalledWith("companion_mdns_stop")
    expect(out).toEqual({ kind: "stopped" })
  })

  it("stopBroadcast returns unsupported on web", async () => {
    const out = await stopBroadcast(async () => null)
    expect(out).toEqual({ kind: "unsupported" })
  })
})

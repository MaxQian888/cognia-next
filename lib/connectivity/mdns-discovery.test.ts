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

  it("returns no-op unsub when startScan throws", async () => {
    const unsub = await subscribe(jest.fn(), async () => ({
      startScan: jest.fn().mockRejectedValue(new Error("permission")),
      stopScan: jest.fn(),
      addListener: async () => ({ remove: jest.fn() }),
    }))
    expect(typeof unsub).toBe("function")
  })
})

describe("default zeroconf adapter (window.Capacitor.Plugins.ZeroConf)", () => {
  afterEach(() => {
    delete (window as { Capacitor?: unknown }).Capacitor
  })

  it("watches _cognia._tcp, listens on 'discover', and maps resolved services", async () => {
    const listeners: Array<(r: unknown) => void> = []
    const events: string[] = []
    const watch = jest.fn().mockResolvedValue(undefined)
    const unwatch = jest.fn().mockResolvedValue(undefined)
    const remove = jest.fn()
    ;(window as unknown as { Capacitor?: { Plugins: Record<string, unknown> } }).Capacitor = {
      Plugins: {
        ZeroConf: {
          watch,
          unwatch,
          addListener: async (event: string, h: (r: unknown) => void) => {
            events.push(event)
            listeners.push(h)
            return { remove }
          },
        },
      },
    }

    const seen: DiscoveredService[] = []
    const unsub = await subscribe((s) => seen.push(s))

    expect(watch).toHaveBeenCalledWith({ type: "_cognia._tcp", domain: "local." })
    expect(events).toEqual(["discover"])

    // `added` carries no addresses yet — must be dropped, not surfaced empty.
    listeners[0]!({ action: "added", service: { name: "cognia-X" } })
    expect(seen).toHaveLength(0)

    listeners[0]!({
      action: "resolved",
      service: {
        name: "cognia-X",
        hostname: "cognia-X.local",
        ipv4Addresses: ["192.168.1.10"],
        port: 7891,
        txtRecord: { ver: "0.1.0", fp: "abcd" },
      },
    })
    expect(seen).toEqual([
      {
        name: "cognia-X",
        hostname: "cognia-X.local",
        ip: "192.168.1.10",
        port: 7891,
        txt: { ver: "0.1.0", fp: "abcd" },
      },
    ])

    await unsub()
    expect(unwatch).toHaveBeenCalledWith({ type: "_cognia._tcp", domain: "local." })
    expect(remove).toHaveBeenCalled()
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

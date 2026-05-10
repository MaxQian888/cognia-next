/**
 * @jest-environment jsdom
 */

import { scanLan, type DiscoveredServer } from "./lan-scanner"

type MdnsHandler = (svc: {
  name: string
  hostname: string
  ip: string
  port: number
  txt: Record<string, string>
}) => void

function makeMdns() {
  let handler: MdnsHandler | null = null
  const unsub = jest.fn()
  const subscribe = jest.fn(async (h: MdnsHandler) => {
    handler = h
    return unsub
  })
  return {
    subscribe,
    unsub,
    fire: (svc: Parameters<MdnsHandler>[0]) => handler?.(svc),
  }
}

// jsdom does not ship a global `Response` — return a minimal shim with the
// pieces probeServer reads (`status` + async `json()`).
type FetchShim = { status: number; json: () => Promise<unknown> }

function makeFetch(handler: (url: string) => FetchShim) {
  return jest.fn((url: string | URL | Request) =>
    Promise.resolve(handler(typeof url === "string" ? url : url.toString()))
  ) as unknown as typeof fetch
}

const cogniaResp = (
  body: unknown = { code: "unauthenticated", message: "no token" }
): FetchShim => ({
  status: 401,
  json: () => Promise.resolve(body),
})

const okResp = (body: unknown = {}): FetchShim => ({
  status: 200,
  json: () => Promise.resolve(body),
})

const status401NonCognia = (body: unknown = { unrelated: true }): FetchShim => ({
  status: 401,
  json: () => Promise.resolve(body),
})

describe("scanLan", () => {
  it("returns history immediately and continues to layer mDNS hits over them", async () => {
    const mdns = makeMdns()
    const onFound = jest.fn()
    const history: DiscoveredServer[] = [
      {
        id: "192.168.1.5:7890",
        ip: "192.168.1.5",
        port: 7890,
        baseUrl: "http://192.168.1.5:7890",
        source: "history",
        discoveredAt: 0,
      },
    ]
    const controller = new AbortController()
    const promise = scanLan({
      signal: controller.signal,
      onFound,
      enableProbeFallback: false,
      mdnsWindowMs: 50,
      mdnsSubscribe: mdns.subscribe as never,
      history,
    })
    // First emit is the history row, synchronous.
    expect(onFound).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "192.168.1.5:7890", source: "history" })
    )
    mdns.fire({
      name: "cognia-AB12",
      hostname: "cognia-AB12.local",
      ip: "192.168.1.5",
      port: 7890,
      txt: { ver: "1.2.3", fp: "ABCD" },
    })
    const list = await promise
    // mDNS overrode the history entry for the same id.
    expect(list).toHaveLength(1)
    expect(list[0].source).toBe("mdns")
    expect(list[0].fingerprint).toBe("ABCD")
    expect(list[0].serverVersion).toBe("1.2.3")
    expect(mdns.unsub).toHaveBeenCalled()
  })

  it("does not regress an mDNS hit back to a probe hit on the same id", async () => {
    const mdns = makeMdns()
    const onFound = jest.fn()
    const fetchMock = makeFetch(() => cogniaResp())
    const promise = scanLan({
      signal: new AbortController().signal,
      onFound,
      mdnsWindowMs: 50,
      mdnsSubscribe: mdns.subscribe as never,
      getLocalIps: async () => ["192.168.7.10"],
      fetchImpl: fetchMock,
      probeConcurrency: 4,
      perProbeTimeoutMs: 1000,
    })
    mdns.fire({
      name: "cognia",
      hostname: "host",
      ip: "192.168.7.20",
      port: 7890,
      txt: { ver: "9", fp: "FF" },
    })
    const result = await promise
    const merged = result.find((s) => s.id === "192.168.7.20:7890")
    expect(merged?.source).toBe("mdns")
  })

  it("falls back to IP-segment probe when mDNS yields nothing", async () => {
    const mdns = makeMdns()
    const onFound = jest.fn()
    const calls: string[] = []
    const fetchMock = makeFetch((url) => {
      calls.push(url)
      // Only one IP in the /24 returns a cognia 401; the rest return random shape.
      if (url.startsWith("http://192.168.5.42:7890")) return cogniaResp({ code: "x" })
      return okResp()
    })
    const result = await scanLan({
      signal: new AbortController().signal,
      onFound,
      mdnsWindowMs: 10,
      mdnsSubscribe: mdns.subscribe as never,
      getLocalIps: async () => ["192.168.5.10"],
      fetchImpl: fetchMock,
      probeConcurrency: 32,
    })
    expect(calls.length).toBeGreaterThan(50) // many probes
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: "192.168.5.42:7890",
      source: "probe",
      ip: "192.168.5.42",
    })
    expect(typeof result[0].latencyMs).toBe("number")
  })

  it("ignores non-cognia 401 responses", async () => {
    const mdns = makeMdns()
    const onFound = jest.fn()
    const fetchMock = makeFetch(() => status401NonCognia())
    const result = await scanLan({
      signal: new AbortController().signal,
      onFound,
      mdnsWindowMs: 10,
      mdnsSubscribe: mdns.subscribe as never,
      getLocalIps: async () => ["192.168.5.10"],
      fetchImpl: fetchMock,
      probeConcurrency: 8,
    })
    expect(result).toEqual([])
    expect(onFound).not.toHaveBeenCalled()
  })

  it("ignores non-401 responses (e.g. random HTTP server on the same port)", async () => {
    const mdns = makeMdns()
    const fetchMock = makeFetch(() => okResp())
    const result = await scanLan({
      signal: new AbortController().signal,
      onFound: jest.fn(),
      mdnsWindowMs: 10,
      mdnsSubscribe: mdns.subscribe as never,
      getLocalIps: async () => ["192.168.0.5"],
      fetchImpl: fetchMock,
    })
    expect(result).toEqual([])
  })

  it("treats fetch failures as misses and keeps probing other IPs", async () => {
    const mdns = makeMdns()
    let calls = 0
    const fetchMock = jest.fn((url: string | URL | Request) => {
      calls++
      const u = typeof url === "string" ? url : url.toString()
      if (u.includes("192.168.0.99")) return Promise.resolve(cogniaResp())
      return Promise.reject(new Error("ECONNREFUSED"))
    }) as unknown as typeof fetch
    const result = await scanLan({
      signal: new AbortController().signal,
      onFound: jest.fn(),
      mdnsWindowMs: 5,
      mdnsSubscribe: mdns.subscribe as never,
      getLocalIps: async () => ["192.168.0.1"],
      fetchImpl: fetchMock,
      probeConcurrency: 16,
    })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("192.168.0.99:7890")
    expect(calls).toBeGreaterThan(1)
  })

  it("aborts in-flight probes when the signal fires", async () => {
    const mdns = makeMdns()
    const controller = new AbortController()
    let aborted = 0
    const fetchMock = jest.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted++
            reject(new DOMException("aborted", "AbortError"))
          })
        })
    ) as unknown as typeof fetch
    const promise = scanLan({
      signal: controller.signal,
      onFound: jest.fn(),
      mdnsWindowMs: 5_000,
      mdnsSubscribe: mdns.subscribe as never,
      getLocalIps: async () => ["192.168.10.5"],
      fetchImpl: fetchMock,
      probeConcurrency: 8,
      perProbeTimeoutMs: 5_000,
    })
    // Let the probe loop start one batch of fetches.
    await new Promise((r) => setTimeout(r, 0))
    controller.abort()
    const result = await promise
    expect(result).toEqual([])
    expect(aborted).toBeGreaterThan(0)
  })

  it("skips the probe path when no local IPs are returned", async () => {
    const mdns = makeMdns()
    const fetchMock = jest.fn() as unknown as typeof fetch
    const result = await scanLan({
      signal: new AbortController().signal,
      onFound: jest.fn(),
      mdnsWindowMs: 5,
      mdnsSubscribe: mdns.subscribe as never,
      getLocalIps: async () => [],
      fetchImpl: fetchMock,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })

  it("returns immediately when the signal is already aborted", async () => {
    const mdns = makeMdns()
    const controller = new AbortController()
    controller.abort()
    const result = await scanLan({
      signal: controller.signal,
      onFound: jest.fn(),
      mdnsWindowMs: 1_000,
      mdnsSubscribe: mdns.subscribe as never,
      enableProbeFallback: false,
    })
    expect(result).toEqual([])
    // mDNS subscribe was never reached.
    expect(mdns.subscribe).not.toHaveBeenCalled()
  })

  it("survives an mDNS subscribe rejection", async () => {
    const subscribe = jest.fn(async () => {
      throw new Error("plugin missing")
    })
    const result = await scanLan({
      signal: new AbortController().signal,
      onFound: jest.fn(),
      mdnsWindowMs: 5,
      mdnsSubscribe: subscribe as never,
      enableProbeFallback: false,
    })
    expect(result).toEqual([])
  })

  it("derives version from the 401 body when present", async () => {
    const mdns = makeMdns()
    const fetchMock = makeFetch(() => cogniaResp({ code: "x", version: "0.4.2" }))
    const result = await scanLan({
      signal: new AbortController().signal,
      onFound: jest.fn(),
      mdnsWindowMs: 5,
      mdnsSubscribe: mdns.subscribe as never,
      getLocalIps: async () => ["192.168.4.4"],
      fetchImpl: fetchMock,
    })
    expect(result.find((s) => s.source === "probe")?.serverVersion).toBe("0.4.2")
  })

  it("disables the probe path when enableProbeFallback is false", async () => {
    const mdns = makeMdns()
    const fetchMock = jest.fn() as unknown as typeof fetch
    const getLocalIps = jest.fn(async () => ["192.168.0.1"])
    await scanLan({
      signal: new AbortController().signal,
      onFound: jest.fn(),
      mdnsWindowMs: 5,
      mdnsSubscribe: mdns.subscribe as never,
      getLocalIps: getLocalIps as never,
      fetchImpl: fetchMock,
      enableProbeFallback: false,
    })
    expect(getLocalIps).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

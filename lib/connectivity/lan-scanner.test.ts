/**
 * @jest-environment jsdom
 */

import {
  PROBE_PORTS,
  pickProbeTargets,
  resolveProbePorts,
  scanLan,
  type DiscoveredServer,
} from "./lan-scanner"
import type { HealthzResult } from "./healthz"

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
        baseUrl: "https://192.168.1.5:7890",
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
      if (url.startsWith("https://192.168.5.42:27890")) return cogniaResp({ code: "x" })
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
      id: "192.168.5.42:27890",
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
    expect(result[0].id).toBe("192.168.0.99:27890")
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
      // The loopback probe is a separate path with its own switch; disable it
      // so this stays a test of the /24 sweep alone.
      enableLoopbackProbe: false,
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
      enableLoopbackProbe: false,
    })
    expect(getLocalIps).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("short-circuits the /24 probe on Android emulator (10.0.2.15 → only probe 10.0.2.2)", async () => {
    const mdns = makeMdns()
    const calls: string[] = []
    const fetchMock = makeFetch((url) => {
      calls.push(url)
      if (url.startsWith("https://10.0.2.2:7890")) return cogniaResp()
      return okResp()
    })
    const result = await scanLan({
      signal: new AbortController().signal,
      onFound: jest.fn(),
      mdnsWindowMs: 5,
      mdnsSubscribe: mdns.subscribe as never,
      getLocalIps: async () => ["10.0.2.15"],
      fetchImpl: fetchMock,
      healthzFetcher: async () => null,
    })
    // /24 fan-out is short-circuited — we hit the gateway alias 10.0.2.2
    // only, but now across PROBE_PORTS (7890/7891/7900/8443) so dev
    // overrides still surface. No 254-IP scan.
    const whoamiCalls = calls.filter((u) => u.endsWith("/api/whoami"))
    const probedIps = new Set(whoamiCalls.map((u) => new URL(u).hostname))
    expect(probedIps).toEqual(new Set(["10.0.2.2"]))
    // PROBE_PORTS coverage on the emulator host alias.
    for (const p of PROBE_PORTS) {
      expect(whoamiCalls.some((u) => u === `https://10.0.2.2:${p}/api/whoami`)).toBe(true)
    }
    // 7890 returned cognia; the other ports returned okResp (non-401) so
    // only the 7890 entry surfaces.
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("10.0.2.2:7890")
  })
})

describe("scanLan — paired tier and multi-port", () => {
  it("layers paired devices first and outranks probe hits on the same id", async () => {
    const mdns = makeMdns()
    const fetchMock = makeFetch(() => cogniaResp())
    const onFound = jest.fn()
    const result = await scanLan({
      signal: new AbortController().signal,
      onFound,
      mdnsWindowMs: 5,
      mdnsSubscribe: mdns.subscribe as never,
      getLocalIps: async () => ["192.168.1.5"],
      fetchImpl: fetchMock,
      probeConcurrency: 32,
      paired: [
        {
          ip: "192.168.1.5",
          port: 7890,
          fingerprint: "PAIRED-FP",
          label: "Home Desktop",
          lastSeenAt: 123,
        },
      ],
      // Healthz returns ok so it cannot regress paired tier back to probe.
      healthzFetcher: async () => null,
    })
    const entry = result.find((s) => s.id === "192.168.1.5:7890")
    expect(entry?.source).toBe("paired")
    expect(entry?.fingerprint).toBe("PAIRED-FP")
    expect(entry?.hostname).toBe("Home Desktop")
    // First onFound call should be the paired entry (rank-4 wins all
    // subsequent same-id emits).
    expect(onFound).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ source: "paired", id: "192.168.1.5:7890" })
    )
  })

  it("expands paired-IP probes across all PROBE_PORTS", async () => {
    const mdns = makeMdns()
    const calls = new Set<string>()
    const fetchMock = makeFetch((url) => {
      calls.add(url)
      return okResp()
    })
    await scanLan({
      signal: new AbortController().signal,
      onFound: jest.fn(),
      mdnsWindowMs: 5,
      mdnsSubscribe: mdns.subscribe as never,
      getLocalIps: async () => ["10.0.2.15"],
      fetchImpl: fetchMock,
      probeConcurrency: 16,
      paired: [{ ip: "10.0.2.2" }],
      healthzFetcher: async () => null,
    })
    // Emulator host alias + paired status → all 4 PROBE_PORTS.
    for (const p of PROBE_PORTS) {
      expect(calls.has(`https://10.0.2.2:${p}/api/whoami`)).toBe(true)
    }
  })

  it("enriches a probe hit with fingerprint from healthz", async () => {
    const mdns = makeMdns()
    const fetchMock = makeFetch(() => cogniaResp())
    const onFound = jest.fn()
    const healthzFetcher = jest.fn(async (): Promise<HealthzResult> => ({
      version: "0.5.0",
      fingerprint: "HEALTHZ-FP",
      advertisedPort: 7890,
      serverId: "0123456789abcdef0123456789abcdef",
    }))
    const result = await scanLan({
      signal: new AbortController().signal,
      onFound,
      mdnsWindowMs: 5,
      mdnsSubscribe: mdns.subscribe as never,
      getLocalIps: async () => ["192.168.6.5"],
      fetchImpl: fetchMock,
      probeConcurrency: 64,
      healthzFetcher: healthzFetcher as never,
    })
    const probed = result.find((s) => s.source === "probe")
    expect(probed?.fingerprint).toBe("HEALTHZ-FP")
    expect(probed?.serverId).toBe("0123456789abcdef0123456789abcdef")
    // onFound should fire twice for the same id: the initial probe hit
    // (no fingerprint) and the upgraded entry (fingerprint enriched).
    const matching = onFound.mock.calls.filter(([s]: [DiscoveredServer]) => s.id === probed!.id)
    expect(matching.length).toBe(2)
    expect(matching[0][0].fingerprint).toBeUndefined()
    expect(matching[1][0].fingerprint).toBe("HEALTHZ-FP")
  })

  it("falls back gracefully when healthz returns null", async () => {
    const mdns = makeMdns()
    const fetchMock = makeFetch(() => cogniaResp())
    const result = await scanLan({
      signal: new AbortController().signal,
      onFound: jest.fn(),
      mdnsWindowMs: 5,
      mdnsSubscribe: mdns.subscribe as never,
      getLocalIps: async () => ["192.168.6.5"],
      fetchImpl: fetchMock,
      probeConcurrency: 64,
      healthzFetcher: async () => null,
    })
    const probed = result.find((s) => s.source === "probe")
    expect(probed?.fingerprint).toBeUndefined()
    expect(probed?.serverId).toBeUndefined()
  })

  it("does not regress paired entry back to probe on enrichment", async () => {
    // Paired ranks above probe; even if healthz returns valid data the
    // emit must not downgrade the paired tier.
    const mdns = makeMdns()
    const fetchMock = makeFetch(() => cogniaResp())
    const healthzFetcher = jest.fn(async (): Promise<HealthzResult> => ({
      version: "0.5.0",
      fingerprint: "HEALTHZ-FP",
      advertisedPort: 7890,
      serverId: "deadbeefdeadbeefdeadbeefdeadbeef",
    }))
    const result = await scanLan({
      signal: new AbortController().signal,
      onFound: jest.fn(),
      mdnsWindowMs: 5,
      mdnsSubscribe: mdns.subscribe as never,
      getLocalIps: async () => ["192.168.6.5"],
      fetchImpl: fetchMock,
      probeConcurrency: 64,
      paired: [{ ip: "192.168.6.5", port: 7890, fingerprint: "PAIRED-FP" }],
      healthzFetcher: healthzFetcher as never,
    })
    const entry = result.find((s) => s.id === "192.168.6.5:7890")
    expect(entry?.source).toBe("paired")
    expect(entry?.fingerprint).toBe("PAIRED-FP")
  })
})

describe("resolveProbePorts", () => {
  it("returns only the primary port for a generic LAN IP", () => {
    expect(resolveProbePorts("192.168.1.7", [], 7890)).toEqual([7890])
  })

  it("expands paired IPs to the full PROBE_PORTS set", () => {
    const out = resolveProbePorts("192.168.1.7", [{ ip: "192.168.1.7" }], 7890)
    for (const p of PROBE_PORTS) {
      expect(out).toContain(p)
    }
  })

  it("expands the Android emulator host alias even without a paired record", () => {
    const out = resolveProbePorts("10.0.2.2", [], 7890)
    for (const p of PROBE_PORTS) {
      expect(out).toContain(p)
    }
  })

  it("dedupes the primary port when it appears in PROBE_PORTS", () => {
    // Primary 7890 is already in PROBE_PORTS — must not appear twice.
    const out = resolveProbePorts("10.0.2.2", [], 7890)
    const counts = new Map<number, number>()
    for (const p of out) counts.set(p, (counts.get(p) ?? 0) + 1)
    for (const [, c] of counts) expect(c).toBe(1)
  })
})

describe("pickProbeTargets", () => {
  it("returns the full /24 for a real LAN address", () => {
    const out = pickProbeTargets(["192.168.1.42"])
    expect(out.length).toBe(253) // 254 less the source IP
    expect(out).toContain("192.168.1.1")
    expect(out).toContain("192.168.1.254")
    expect(out).not.toContain("192.168.1.42")
  })

  it("dedupes overlapping /24 ranges", () => {
    const out = pickProbeTargets(["192.168.1.10", "192.168.1.99"])
    // Both source IPs fall in the same /24. Each enumerator drops only its
    // own source, so the union covers the full /24 — we just want no
    // duplicate entries.
    expect(new Set(out).size).toBe(out.length)
    // Sanity-check that the union really did fill in for the other source.
    expect(out).toContain("192.168.1.10")
    expect(out).toContain("192.168.1.99")
  })

  it("collapses to a single gateway probe when only the Android emulator IP is present", () => {
    expect(pickProbeTargets(["10.0.2.15"])).toEqual(["10.0.2.2"])
  })

  it("short-circuits when every IP is in the 10.0.2.x emulator subnet", () => {
    // WebRTC ICE can return the gateway (10.0.2.2) or other virtual addresses
    // instead of the guest IP (10.0.2.15). Probing the full /24 is still wasteful.
    expect(pickProbeTargets(["10.0.2.2"])).toEqual(["10.0.2.2"])
    expect(pickProbeTargets(["10.0.2.2", "10.0.2.3"])).toEqual(["10.0.2.2"])
    expect(pickProbeTargets(["10.0.2.7", "10.0.2.8"])).toEqual(["10.0.2.2"])
  })

  it("does NOT short-circuit when the emulator IP is mixed with a real LAN IP", () => {
    // Defensive: a multi-NIC device that happens to expose 10.0.2.15 alongside
    // a real LAN address should still get the full probe over the LAN side.
    const out = pickProbeTargets(["10.0.2.15", "192.168.1.7"])
    expect(out.length).toBeGreaterThan(200)
    expect(out).toContain("192.168.1.1")
  })

  it("does NOT short-circuit a real LAN IP that happens to start with 10.", () => {
    const out = pickProbeTargets(["10.1.0.5"])
    expect(out.length).toBe(253)
    expect(out).toContain("10.1.0.1")
  })
})

/**
 * Loopback browser-access path — the browser tab's only route to discovery.
 * mDNS needs a multicast socket and the /24 sweep is seeded by ICE candidates
 * browsers anonymise away, so without this a tab finds nothing, ever.
 */
describe("scanLan — loopback probe", () => {
  const found = {
    kind: "found" as const,
    baseUrl: "http://127.0.0.1:27891",
    health: {
      version: "1.2.3",
      fingerprint: "sha256-abc",
      advertisedPort: 27890,
      serverId: "install-1",
    },
  }

  function scanWith(loopbackProbe: unknown, extra: Record<string, unknown> = {}) {
    const mdns = makeMdns()
    return scanLan({
      signal: new AbortController().signal,
      onFound: jest.fn(),
      mdnsWindowMs: 5,
      mdnsSubscribe: mdns.subscribe as never,
      getLocalIps: async () => [],
      fetchImpl: jest.fn() as unknown as typeof fetch,
      loopbackProbe: loopbackProbe as never,
      ...extra,
    })
  }

  it("surfaces a Host found on loopback, with its verified fingerprint", async () => {
    const result = await scanWith(jest.fn(async () => found))

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: "127.0.0.1:27891",
      source: "loopback",
      baseUrl: "http://127.0.0.1:27891",
      serverVersion: "1.2.3",
      fingerprint: "sha256-abc",
      serverId: "install-1",
    })
  })

  it("reports a Host that refused this origin instead of dropping it silently", async () => {
    // The 403 comes back without CORS headers, so the fetch failure looks
    // exactly like a closed port. Reporting "nothing found" would state an
    // absence the probe just disproved.
    const onLoopbackBlocked = jest.fn()
    const result = await scanWith(
      jest.fn(async () => ({
        kind: "blocked" as const,
        baseUrl: "http://127.0.0.1:27891",
        origin: "http://localhost:3000",
      })),
      { onLoopbackBlocked }
    )

    expect(onLoopbackBlocked).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:27891",
      origin: "http://localhost:3000",
    })
    // A blocked Host is not connectable, so it must not enter the server list.
    expect(result).toEqual([])
  })

  it("stays quiet when nothing answers on loopback", async () => {
    const onLoopbackBlocked = jest.fn()
    const result = await scanWith(
      jest.fn(async () => ({ kind: "absent" as const })),
      {
        onLoopbackBlocked,
      }
    )

    expect(onLoopbackBlocked).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })

  it("does not run when the caller disables it", async () => {
    // On a phone or the desktop shell, `127.0.0.1` is the device itself —
    // there is nothing to discover there.
    const loopbackProbe = jest.fn(async () => found)
    await scanWith(loopbackProbe, { enableLoopbackProbe: false })

    expect(loopbackProbe).not.toHaveBeenCalled()
  })
})

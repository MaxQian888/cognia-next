import { resolveLanBaseUrl } from "./lan-resolver"
import type { DiscoveredServer } from "./lan-scanner"
import type { ScanLanOptions } from "./lan-scanner"

const FP = "AA:BB:CC:DD"

function server(
  partial: Partial<DiscoveredServer> & Pick<DiscoveredServer, "baseUrl">
): DiscoveredServer {
  return {
    id: partial.id ?? `${partial.ip ?? "192.168.1.5"}:${partial.port ?? 7890}`,
    ip: partial.ip ?? "192.168.1.5",
    port: partial.port ?? 7890,
    source: partial.source ?? "probe",
    discoveredAt: partial.discoveredAt ?? 1,
    ...partial,
  }
}

/** Build a scanLan double that returns a fixed list and records the call. */
function fakeScan(servers: DiscoveredServer[]): {
  impl: (opts: ScanLanOptions) => Promise<DiscoveredServer[]>
  calls: ScanLanOptions[]
} {
  const calls: ScanLanOptions[] = []
  return {
    calls,
    impl: async (opts: ScanLanOptions) => {
      calls.push(opts)
      return servers
    },
  }
}

describe("resolveLanBaseUrl", () => {
  it("returns the LAN baseUrl of a fingerprint-matched mDNS hit", async () => {
    const scan = fakeScan([
      server({ baseUrl: "https://192.168.1.5:7890", source: "mdns", fingerprint: FP }),
    ])
    const result = await resolveLanBaseUrl({
      config: { baseUrl: "https://abc.trycloudflare.com", serverFingerprint: FP },
      signal: new AbortController().signal,
      scanLanImpl: scan.impl,
    })
    expect(result.lanBaseUrl).toBe("https://192.168.1.5:7890")
  })

  it("matches the fingerprint case-insensitively", async () => {
    const scan = fakeScan([
      server({
        baseUrl: "https://192.168.1.9:7890",
        source: "probe",
        fingerprint: FP.toLowerCase(),
      }),
    ])
    const result = await resolveLanBaseUrl({
      config: { baseUrl: "https://192.168.1.9:7890", serverFingerprint: FP },
      signal: new AbortController().signal,
      scanLanImpl: scan.impl,
    })
    expect(result.lanBaseUrl).toBe("https://192.168.1.9:7890")
  })

  it("returns null when the discovered fingerprint does not match the pin", async () => {
    const scan = fakeScan([
      server({ baseUrl: "https://192.168.1.5:7890", source: "mdns", fingerprint: "ZZ:ZZ" }),
    ])
    const result = await resolveLanBaseUrl({
      config: { baseUrl: "https://192.168.1.5:7890", serverFingerprint: FP },
      signal: new AbortController().signal,
      scanLanImpl: scan.impl,
    })
    expect(result.lanBaseUrl).toBeNull()
  })

  it("returns null and never scans when the config has no fingerprint pin", async () => {
    const scan = fakeScan([
      server({ baseUrl: "https://192.168.1.5:7890", source: "mdns", fingerprint: FP }),
    ])
    const result = await resolveLanBaseUrl({
      config: { baseUrl: "https://192.168.1.5:7890" },
      signal: new AbortController().signal,
      scanLanImpl: scan.impl,
    })
    expect(result.lanBaseUrl).toBeNull()
    expect(scan.calls).toHaveLength(0)
  })

  it("rejects a fingerprint-matched hit that classifies as ws-tunnel", async () => {
    const scan = fakeScan([
      server({ baseUrl: "https://1.2.3.4:443", ip: "1.2.3.4", source: "mdns", fingerprint: FP }),
    ])
    const result = await resolveLanBaseUrl({
      config: { baseUrl: "https://abc.trycloudflare.com", serverFingerprint: FP },
      signal: new AbortController().signal,
      scanLanImpl: scan.impl,
    })
    expect(result.lanBaseUrl).toBeNull()
  })

  it("rejects a probe-only hit that carries no fingerprint", async () => {
    const scan = fakeScan([server({ baseUrl: "https://192.168.1.5:7890", source: "probe" })])
    const result = await resolveLanBaseUrl({
      config: { baseUrl: "https://192.168.1.5:7890", serverFingerprint: FP },
      signal: new AbortController().signal,
      scanLanImpl: scan.impl,
    })
    expect(result.lanBaseUrl).toBeNull()
  })

  it("rejects the echoed 'paired' / 'history' seed (not a live discovery)", async () => {
    const scan = fakeScan([
      server({ baseUrl: "https://192.168.1.5:7890", source: "paired", fingerprint: FP }),
      server({ baseUrl: "https://192.168.1.5:7890", source: "history", fingerprint: FP }),
    ])
    const result = await resolveLanBaseUrl({
      config: { baseUrl: "https://192.168.1.5:7890", serverFingerprint: FP },
      signal: new AbortController().signal,
      scanLanImpl: scan.impl,
    })
    expect(result.lanBaseUrl).toBeNull()
  })

  it("returns null when the scan surfaces nothing", async () => {
    const scan = fakeScan([])
    const result = await resolveLanBaseUrl({
      config: { baseUrl: "https://192.168.1.5:7890", serverFingerprint: FP },
      signal: new AbortController().signal,
      scanLanImpl: scan.impl,
    })
    expect(result.lanBaseUrl).toBeNull()
  })

  it("never throws when the scan rejects", async () => {
    const result = await resolveLanBaseUrl({
      config: { baseUrl: "https://192.168.1.5:7890", serverFingerprint: FP },
      signal: new AbortController().signal,
      scanLanImpl: async () => {
        throw new Error("scan exploded")
      },
    })
    expect(result.lanBaseUrl).toBeNull()
  })

  it("returns null for a malformed baseUrl", async () => {
    const scan = fakeScan([])
    const result = await resolveLanBaseUrl({
      config: { baseUrl: "not a url", serverFingerprint: FP },
      signal: new AbortController().signal,
      scanLanImpl: scan.impl,
    })
    expect(result.lanBaseUrl).toBeNull()
  })

  it("passes the paired desktop ip/port/fingerprint to the scanner so alt ports are swept", async () => {
    const scan = fakeScan([])
    await resolveLanBaseUrl({
      config: { baseUrl: "https://192.168.1.5:7891", serverFingerprint: FP },
      signal: new AbortController().signal,
      scanLanImpl: scan.impl,
    })
    expect(scan.calls).toHaveLength(1)
    expect(scan.calls[0].paired).toEqual([{ ip: "192.168.1.5", port: 7891, fingerprint: FP }])
  })
})

/**
 * @jest-environment jsdom
 */
import { buildCandidates, pickReachable, type ConnectionCandidate } from "./connection-strategy"

describe("buildCandidates", () => {
  it("includes mDNS service whose fingerprint matches", () => {
    const out = buildCandidates({
      discovered: [
        {
          name: "cognia-X",
          hostname: "cognia-X.local",
          ip: "192.168.1.10",
          port: 7891,
          txt: { fp: "DEADBEEF" },
        },
      ],
      expectedFingerprint: "deadbeef",
    })
    expect(out).toEqual([
      {
        label: "LAN · cognia-X",
        baseUrl: "https://192.168.1.10:7891",
        origin: "mdns",
      },
    ])
  })

  it("excludes mDNS service with mismatched fingerprint", () => {
    const out = buildCandidates({
      discovered: [
        {
          name: "evil",
          hostname: "evil.local",
          ip: "192.168.1.99",
          port: 7891,
          txt: { fp: "different" },
        },
      ],
      expectedFingerprint: "deadbeef",
    })
    expect(out).toHaveLength(0)
  })

  it("excludes mDNS service when no fingerprint expected", () => {
    const out = buildCandidates({
      discovered: [
        {
          name: "x",
          hostname: "x.local",
          ip: "1.1.1.1",
          port: 1,
          txt: { fp: "abc" },
        },
      ],
    })
    expect(out).toHaveLength(0)
  })

  it("includes tunnel after LAN", () => {
    const out = buildCandidates({
      discovered: [
        {
          name: "cognia-X",
          hostname: "x.local",
          ip: "10.0.0.1",
          port: 7891,
          txt: { fp: "abc" },
        },
      ],
      expectedFingerprint: "abc",
      tunnelUrl: "https://abc.trycloudflare.com",
    })
    expect(out.map((c) => c.origin)).toEqual(["mdns", "tunnel"])
  })

  it("strips trailing slash from tunnel + cached URLs", () => {
    const out = buildCandidates({
      tunnelUrl: "https://abc.trycloudflare.com/",
      cachedBaseUrl: "https://10.0.0.1:7891/",
    })
    expect(out[0].baseUrl).toBe("https://abc.trycloudflare.com")
    expect(out[1].baseUrl).toBe("https://10.0.0.1:7891")
  })

  it("dedupes cached baseUrl when already present from tunnel", () => {
    const out = buildCandidates({
      tunnelUrl: "https://x.com",
      cachedBaseUrl: "https://x.com",
    })
    expect(out).toHaveLength(1)
  })

  it("ranks a pre-verified LAN address ahead of tunnel and cached", () => {
    const out = buildCandidates({
      lanBaseUrl: "https://192.168.1.5:27890",
      tunnelUrl: "https://abc.trycloudflare.com",
      cachedBaseUrl: "https://old.example:27890",
    })
    expect(out.map((c) => c.origin)).toEqual(["mdns", "tunnel", "cached"])
    expect(out[0].baseUrl).toBe("https://192.168.1.5:27890")
  })

  it("labels non-mDNS candidates with a locale-free host, never prose", () => {
    // `label` feeds logs/diagnostics; UI copy is derived from `origin`. A
    // literal here would hard-code one language into a lib module.
    const out = buildCandidates({
      tunnelUrl: "https://abc.trycloudflare.com",
      cachedBaseUrl: "https://10.0.0.1:27890",
    })
    expect(out.map((c) => c.label)).toEqual(["abc.trycloudflare.com", "10.0.0.1:27890"])
  })

  it("dedupes a pre-verified LAN address against an identical mDNS hit", () => {
    const out = buildCandidates({
      lanBaseUrl: "https://192.168.1.10:7891",
      discovered: [
        {
          name: "cognia-X",
          hostname: "cognia-X.local",
          ip: "192.168.1.10",
          port: 7891,
          txt: { fp: "deadbeef" },
        },
      ],
      expectedFingerprint: "deadbeef",
    })
    expect(out).toHaveLength(1)
  })

  it("returns an empty list when the device knows no addresses at all", () => {
    expect(buildCandidates({})).toEqual([])
  })

  it("falls back to the raw string when a candidate URL is unparseable", () => {
    const out = buildCandidates({ cachedBaseUrl: "not a url" })
    expect(out).toEqual([{ label: "not a url", baseUrl: "not a url", origin: "cached" }])
  })
})

describe("pickReachable", () => {
  const list: ConnectionCandidate[] = [
    { label: "a", baseUrl: "https://a", origin: "mdns" },
    { label: "b", baseUrl: "https://b", origin: "tunnel" },
    { label: "c", baseUrl: "https://c", origin: "cached" },
  ]

  it("returns the first probe that returns true", async () => {
    const out = await pickReachable(list, async (c) => c.baseUrl === "https://b")
    expect(out?.baseUrl).toBe("https://b")
  })

  it("returns null when all probes fail", async () => {
    const out = await pickReachable(list, async () => false)
    expect(out).toBeNull()
  })

  it("treats throwing probes as failures", async () => {
    const out = await pickReachable(list, async (c) => {
      if (c.origin === "mdns") throw new Error("timeout")
      return c.origin === "tunnel"
    })
    expect(out?.origin).toBe("tunnel")
  })
})

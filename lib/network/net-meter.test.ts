import type { ProviderResolution } from "@/lib/ai/provider-consumption"

const invoke = jest.fn()
jest.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

import {
  computeThroughput,
  latencyQuality,
  probeLatency,
  readNetworkCounters,
  resolveLatencyTarget,
  summarizeLatency,
} from "./net-meter"

const SIGNALING = "wss://signal.example.com/ws"

function resolved(over: Record<string, unknown>): ProviderResolution {
  return {
    kind: "resolved",
    providerId: "anthropic",
    protocol: "anthropic",
    apiKey: "k",
    baseURL: undefined,
    model: undefined,
    isCustomProvider: false,
    useProxy: false,
    ...over,
  } as ProviderResolution
}

beforeEach(() => invoke.mockReset())

describe("native bridge", () => {
  it("reads counters through the native command", async () => {
    invoke.mockResolvedValue({ rxBytes: 1, txBytes: 2, interfaces: [], atMs: 3 })
    await expect(readNetworkCounters()).resolves.toEqual({
      rxBytes: 1,
      txBytes: 2,
      interfaces: [],
      atMs: 3,
    })
    expect(invoke).toHaveBeenCalledWith("network_interface_counters")
  })

  it("passes the probe target, and the timeout only when given", async () => {
    invoke.mockResolvedValue({ ok: true })
    await probeLatency("https://api.example.com/v1")
    expect(invoke).toHaveBeenLastCalledWith("network_latency_probe", {
      input: { url: "https://api.example.com/v1" },
    })
    await probeLatency("https://api.example.com/v1", 500)
    expect(invoke).toHaveBeenLastCalledWith("network_latency_probe", {
      input: { url: "https://api.example.com/v1", timeoutMs: 500 },
    })
  })
})

describe("computeThroughput", () => {
  it("divides the byte delta by the real interval", () => {
    expect(
      computeThroughput(
        { rxBytes: 1_000, txBytes: 500, atMs: 10_000 },
        { rxBytes: 5_000, txBytes: 1_500, atMs: 12_000 }
      )
    ).toEqual({ rxBps: 2_000, txBps: 500 })
  })

  it("gives no rate when no time passed or the clock went backwards", () => {
    const a = { rxBytes: 0, txBytes: 0, atMs: 1_000 }
    expect(computeThroughput(a, { ...a })).toBeNull()
    expect(computeThroughput(a, { rxBytes: 10, txBytes: 10, atMs: 500 })).toBeNull()
  })

  it("gives no rate when a counter dropped (interface gone or reset)", () => {
    expect(
      computeThroughput(
        { rxBytes: 5_000, txBytes: 100, atMs: 0 },
        { rxBytes: 1_000, txBytes: 200, atMs: 2_000 }
      )
    ).toBeNull()
  })
})

describe("resolveLatencyTarget", () => {
  it("measures to the provider's REST base when one resolves", () => {
    expect(resolveLatencyTarget({ provider: resolved({}), signalingUrl: SIGNALING })).toEqual({
      kind: "provider",
      providerId: "anthropic",
      url: "https://api.anthropic.com/v1",
    })
    expect(
      resolveLatencyTarget({
        provider: resolved({
          providerId: "deepseek",
          protocol: "openai",
          baseURL: "https://api.deepseek.com/v1",
        }),
        signalingUrl: SIGNALING,
      })
    ).toEqual({ kind: "provider", providerId: "deepseek", url: "https://api.deepseek.com/v1" })
  })

  it("falls back to the rendezvous when no provider is usable", () => {
    expect(
      resolveLatencyTarget({
        provider: { kind: "unresolved" } as unknown as ProviderResolution,
        signalingUrl: SIGNALING,
      })
    ).toEqual({ kind: "relay", url: "https://signal.example.com/healthz" })
  })

  it("falls back to the rendezvous when the provider has no HTTP base (an SDK default)", () => {
    expect(
      resolveLatencyTarget({
        provider: resolved({ protocol: "bedrock", baseURL: undefined }),
        signalingUrl: SIGNALING,
      })
    ).toEqual({ kind: "relay", url: "https://signal.example.com/healthz" })
  })

  it("returns null when there is nothing to measure against", () => {
    expect(
      resolveLatencyTarget({
        provider: { kind: "unresolved" } as unknown as ProviderResolution,
        signalingUrl: "not a url",
      })
    ).toBeNull()
  })
})

describe("latencyQuality", () => {
  it("buckets round trips and failures", () => {
    expect(latencyQuality(null)).toBeNull()
    expect(latencyQuality({ ok: false, latencyMs: null })).toBe("down")
    expect(latencyQuality({ ok: true, latencyMs: null })).toBe("down")
    expect(latencyQuality({ ok: true, latencyMs: 80 })).toBe("good")
    expect(latencyQuality({ ok: true, latencyMs: 150 })).toBe("good")
    expect(latencyQuality({ ok: true, latencyMs: 300 })).toBe("fair")
    expect(latencyQuality({ ok: true, latencyMs: 900 })).toBe("poor")
  })
})

describe("summarizeLatency", () => {
  it("returns null for no probes", () => {
    expect(summarizeLatency([])).toBeNull()
  })

  it("averages answered probes and counts the failed ones as loss", () => {
    const summary = summarizeLatency([
      { ok: true, latencyMs: 100 },
      { ok: false, latencyMs: null },
      { ok: true, latencyMs: 300 },
      { ok: true, latencyMs: 200 },
    ])
    expect(summary).toEqual({
      avgMs: 200,
      minMs: 100,
      maxMs: 300,
      // |300-100| + |200-300| over two steps.
      jitterMs: 150,
      lossRatio: 0.25,
    })
  })

  it("reports full loss when nothing answered", () => {
    expect(summarizeLatency([{ ok: false, latencyMs: null }])).toEqual({
      avgMs: 0,
      minMs: 0,
      maxMs: 0,
      jitterMs: 0,
      lossRatio: 1,
    })
  })

  it("has no jitter for a single answer", () => {
    expect(summarizeLatency([{ ok: true, latencyMs: 42 }])?.jitterMs).toBe(0)
  })
})

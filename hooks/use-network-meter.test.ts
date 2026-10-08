/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const readNetworkCounters = jest.fn()
const probeLatency = jest.fn()
jest.mock("@/lib/network/net-meter", () => {
  const actual = jest.requireActual("@/lib/network/net-meter")
  return {
    ...actual,
    readNetworkCounters: () => readNetworkCounters(),
    probeLatency: (url: string) => probeLatency(url),
  }
})

const warn = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: { ui: { child: () => ({ warn: (...a: unknown[]) => warn(...a) }) } },
}))

let settings: Record<string, unknown> | null = null
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: { settings: Record<string, unknown> | null }) => unknown) =>
    selector({ settings }),
}))

import {
  LATENCY_HISTORY,
  LATENCY_INTERVAL_MS,
  THROUGHPUT_HISTORY,
  THROUGHPUT_INTERVAL_MS,
  useNetworkMeter,
} from "./use-network-meter"
import { DEFAULT_SIGNALING_URL } from "@/lib/signaling/types"
import { relayHealthUrl } from "@/lib/signaling/relay-health"

function counters(rx: number, tx: number, atMs: number) {
  return { rxBytes: rx, txBytes: tx, atMs, interfaces: [{ name: "en0", rxBytes: rx, txBytes: tx }] }
}
function sample(latencyMs: number | null, over: Record<string, unknown> = {}) {
  return {
    ok: latencyMs != null,
    latencyMs,
    connectMs: null,
    status: 404,
    host: "h",
    route: null,
    error: null,
    atMs: 0,
    ...over,
  }
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true })
  document.dispatchEvent(new Event("visibilitychange"))
}

beforeEach(() => {
  jest.useFakeTimers()
  readNetworkCounters.mockReset()
  probeLatency.mockReset().mockResolvedValue(sample(120))
  warn.mockReset()
  settings = null
  setVisibility("visible")
})
afterEach(() => jest.useRealTimers())

describe("useNetworkMeter", () => {
  it("does nothing while disabled (outside the desktop shell)", async () => {
    const { result } = renderHook(() => useNetworkMeter({ enabled: false }))
    await flush()
    expect(readNetworkCounters).not.toHaveBeenCalled()
    expect(probeLatency).not.toHaveBeenCalled()
    expect(result.current.available).toBe(false)
  })

  it("turns two counter reads into a rate and keeps a bounded history", async () => {
    let t = 0
    readNetworkCounters.mockImplementation(async () => {
      t += 1
      return counters(t * 4_000, t * 1_000, t * 2_000)
    })
    const { result } = renderHook(() => useNetworkMeter({ enabled: true }))
    await flush()
    expect(result.current.available).toBe(true)
    expect(result.current.throughput).toBeNull()
    expect(result.current.interfaces.map((i) => i.name)).toEqual(["en0"])

    await act(async () => {
      jest.advanceTimersByTime(THROUGHPUT_INTERVAL_MS)
    })
    await flush()
    expect(result.current.throughput).toEqual({ rxBps: 2_000, txBps: 500 })

    for (let i = 0; i < THROUGHPUT_HISTORY + 5; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(THROUGHPUT_INTERVAL_MS)
      })
      await flush()
    }
    expect(result.current.rxHistory).toHaveLength(THROUGHPUT_HISTORY)
    expect(result.current.txHistory.at(-1)).toBe(500)
  })

  it("probes the rendezvous when no provider is configured, then on its cadence", async () => {
    readNetworkCounters.mockResolvedValue(counters(0, 0, 1))
    const { result } = renderHook(() => useNetworkMeter({ enabled: true }))
    await flush()
    const relay = relayHealthUrl(DEFAULT_SIGNALING_URL)
    expect(result.current.target).toEqual({ kind: "relay", url: relay })
    expect(probeLatency).toHaveBeenCalledWith(relay)
    expect(result.current.latency?.latencyMs).toBe(120)

    probeLatency.mockResolvedValue(sample(null, { error: "timed out" }))
    await act(async () => {
      jest.advanceTimersByTime(LATENCY_INTERVAL_MS)
    })
    await flush()
    expect(result.current.latency?.ok).toBe(false)
    expect(result.current.latencyHistory).toHaveLength(2)
  })

  it("keeps the latency history bounded", async () => {
    readNetworkCounters.mockResolvedValue(counters(0, 0, 1))
    const { result } = renderHook(() => useNetworkMeter({ enabled: true }))
    await flush()
    for (let i = 0; i < LATENCY_HISTORY + 3; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(LATENCY_INTERVAL_MS)
      })
      await flush()
    }
    expect(result.current.latencyHistory).toHaveLength(LATENCY_HISTORY)
  })

  it("measures to the configured provider and restarts the history when it changes", async () => {
    readNetworkCounters.mockResolvedValue(counters(0, 0, 1))
    settings = { signalingUrl: "wss://relay.example.com" }
    const { result, rerender } = renderHook(() => useNetworkMeter({ enabled: true }))
    await flush()
    expect(result.current.target?.kind).toBe("relay")
    expect(result.current.latencyHistory).toHaveLength(1)

    settings = {
      defaultProvider: "deepseek",
      providerSettings: {
        deepseek: { enabled: true, apiKey: "k", baseURL: "https://api.deepseek.com/v1" },
      },
    }
    rerender()
    await flush()
    expect(result.current.target).toMatchObject({ kind: "provider", providerId: "deepseek" })
    expect(probeLatency).toHaveBeenLastCalledWith(result.current.target?.url)
    // Probes against the old hop are not this hop's history.
    expect(result.current.latencyHistory).toHaveLength(1)
  })

  it("never stacks a second probe on a slow one", async () => {
    readNetworkCounters.mockResolvedValue(counters(0, 0, 1))
    probeLatency.mockImplementation(() => new Promise(() => {}))
    renderHook(() => useNetworkMeter({ enabled: true }))
    await flush()
    await act(async () => {
      jest.advanceTimersByTime(LATENCY_INTERVAL_MS * 3)
    })
    expect(probeLatency).toHaveBeenCalledTimes(1)
  })

  it("pauses while hidden and starts a fresh baseline on return", async () => {
    let t = 0
    readNetworkCounters.mockImplementation(async () => {
      t += 1
      return counters(t * 1_000, 0, t * 2_000)
    })
    const { result } = renderHook(() => useNetworkMeter({ enabled: true }))
    await flush()
    await act(async () => {
      jest.advanceTimersByTime(THROUGHPUT_INTERVAL_MS)
    })
    await flush()
    expect(result.current.rxHistory).toEqual([500])
    act(() => setVisibility("hidden"))
    const reads = readNetworkCounters.mock.calls.length
    const probes = probeLatency.mock.calls.length
    await act(async () => {
      jest.advanceTimersByTime(LATENCY_INTERVAL_MS * 2)
    })
    expect(readNetworkCounters).toHaveBeenCalledTimes(reads)
    expect(probeLatency).toHaveBeenCalledTimes(probes)

    t += 50 // time away: counters moved a lot
    act(() => setVisibility("visible"))
    await flush()
    // First read after returning is a new baseline, not a rate over the gap.
    expect(readNetworkCounters.mock.calls.length).toBe(reads + 1)
    expect(result.current.rxHistory).toEqual([500])
    await act(async () => {
      jest.advanceTimersByTime(THROUGHPUT_INTERVAL_MS)
    })
    await flush()
    expect(result.current.rxHistory).toEqual([500, 500])
  })

  it("logs a failed read and keeps going", async () => {
    readNetworkCounters
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(counters(0, 0, 1))
    probeLatency.mockRejectedValueOnce(new Error("no ipc"))
    const { result } = renderHook(() => useNetworkMeter({ enabled: true }))
    await flush()
    expect(warn).toHaveBeenCalledWith("interface counter read failed", { error: "boom" })
    expect(warn).toHaveBeenCalledWith("latency probe failed", { error: "no ipc" })
    await act(async () => {
      jest.advanceTimersByTime(THROUGHPUT_INTERVAL_MS)
    })
    await flush()
    expect(result.current.available).toBe(true)
  })
})

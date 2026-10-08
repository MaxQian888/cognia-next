/**
 * The status bar's live network readout: throughput from the machine's
 * interface counters, and latency from a round trip to the endpoint the app
 * actually talks to.
 *
 * Both measurements are native (`cognia_net::net_meter`, behind the
 * `network_interface_counters` / `network_latency_probe` commands); this module
 * is the typed bridge plus the pure arithmetic around it, kept free of React
 * so the rate maths and the target choice are testable on their own.
 *
 * **Throughput** is a rate between two reads of cumulative counters. The
 * native side counts only physical interfaces (no loopback, no tunnels), so a
 * VPN or a TUN-mode proxy does not double the figure. A counter that goes
 * backwards — an interface came or went, a driver reset — yields no rate for
 * that interval rather than a negative or absurd one.
 *
 * **Latency** goes to the model provider when one is configured, because that
 * is the hop every turn pays; otherwise to the Cognia rendezvous, the hop
 * remote access pays. Either way the probe runs through the live proxy policy
 * and sends no credentials — any HTTP answer is a measurement.
 */

import { invoke } from "@tauri-apps/api/core"

import { restBaseOf } from "@/lib/ai/operations/handlers/http"
import type { ProviderResolution } from "@/lib/ai/provider-consumption"
import { relayHealthUrl } from "@/lib/signaling/relay-health"
import type { ProxyRouteSummary } from "@/types/network/proxy"

/** Mirror of `cognia_net::net_meter::InterfaceCounters`. */
export interface InterfaceCounters {
  name: string
  rxBytes: number
  txBytes: number
}

/** Mirror of `cognia_net::net_meter::NetworkCounters`. */
export interface NetworkCounters {
  rxBytes: number
  txBytes: number
  /** Counted interfaces, busiest first. */
  interfaces: InterfaceCounters[]
  /** Wall-clock ms of the read. */
  atMs: number
}

/** Mirror of `cognia_net::net_meter::LatencySample`. */
export interface LatencySample {
  ok: boolean
  latencyMs: number | null
  /** Set when this probe had to open a connection (DNS + TCP + TLS + request). */
  connectMs: number | null
  status: number | null
  host: string
  route: ProxyRouteSummary | null
  error: string | null
  atMs: number
}

export interface Throughput {
  /** Download, bytes per second. */
  rxBps: number
  /** Upload, bytes per second. */
  txBps: number
}

export function readNetworkCounters(): Promise<NetworkCounters> {
  return invoke<NetworkCounters>("network_interface_counters")
}

export function probeLatency(url: string, timeoutMs?: number): Promise<LatencySample> {
  return invoke<LatencySample>("network_latency_probe", {
    input: timeoutMs === undefined ? { url } : { url, timeoutMs },
  })
}

/**
 * The rate between two counter reads, or `null` when the pair cannot give an
 * honest one: no time passed, the clock went backwards, or a counter dropped
 * (an interface disappeared or was reset between the reads).
 */
export function computeThroughput(
  prev: Pick<NetworkCounters, "rxBytes" | "txBytes" | "atMs">,
  next: Pick<NetworkCounters, "rxBytes" | "txBytes" | "atMs">
): Throughput | null {
  const seconds = (next.atMs - prev.atMs) / 1000
  if (!(seconds > 0)) return null
  const rx = next.rxBytes - prev.rxBytes
  const tx = next.txBytes - prev.txBytes
  if (rx < 0 || tx < 0) return null
  return { rxBps: rx / seconds, txBps: tx / seconds }
}

export type LatencyTarget =
  { kind: "provider"; providerId: string; url: string } | { kind: "relay"; url: string }

/**
 * Where the latency probe should go: the resolved provider's REST base when it
 * has one, else the rendezvous health endpoint. `null` when neither yields a
 * usable URL (a Bedrock-only setup with a malformed signaling URL).
 */
export function resolveLatencyTarget(input: {
  provider: ProviderResolution
  signalingUrl: string
}): LatencyTarget | null {
  const { provider, signalingUrl } = input
  if (provider.kind === "resolved") {
    const base = restBaseOf(provider)
    if (base && isHttpUrl(base)) {
      return { kind: "provider", providerId: provider.providerId, url: base }
    }
  }
  const relay = relayHealthUrl(signalingUrl)
  return relay ? { kind: "relay", url: relay } : null
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.length > 0
  } catch {
    return false
  }
}

export type LatencyQuality = "good" | "fair" | "poor" | "down"

/**
 * Bucket a round trip for the status dot. The thresholds are where an
 * interactive turn starts to feel it: a streaming reply's first token waits on
 * at least one round trip, and past ~400 ms that wait is noticeable before
 * the model has done anything.
 */
export function latencyQuality(
  sample: Pick<LatencySample, "ok" | "latencyMs"> | null
): LatencyQuality | null {
  if (!sample) return null
  if (!sample.ok || sample.latencyMs == null) return "down"
  if (sample.latencyMs <= 150) return "good"
  if (sample.latencyMs <= 400) return "fair"
  return "poor"
}

export interface LatencySummary {
  avgMs: number
  minMs: number
  maxMs: number
  /** Mean absolute difference between consecutive samples. */
  jitterMs: number
  /** Share of probes that got no answer, 0–1. */
  lossRatio: number
}

/** Summarize a probe history (oldest → newest); `null` for an empty one. */
export function summarizeLatency(
  history: readonly Pick<LatencySample, "ok" | "latencyMs">[]
): LatencySummary | null {
  if (history.length === 0) return null
  const values = history
    .filter((s) => s.ok && s.latencyMs != null)
    .map((s) => s.latencyMs as number)
  const lossRatio = (history.length - values.length) / history.length
  if (values.length === 0) return { avgMs: 0, minMs: 0, maxMs: 0, jitterMs: 0, lossRatio }
  let jitter = 0
  for (let i = 1; i < values.length; i += 1) jitter += Math.abs(values[i] - values[i - 1])
  return {
    avgMs: values.reduce((a, b) => a + b, 0) / values.length,
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
    jitterMs: values.length > 1 ? jitter / (values.length - 1) : 0,
    lossRatio,
  }
}

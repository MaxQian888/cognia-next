"use client"

import {
  capacitorHttpGet,
  combineAbortSignals,
  getCapacitorHttp,
  type CapacitorHttpPlugin,
} from "./capacitor-http"
import { fetchHealthz } from "./healthz"
import type { DiscoveredService } from "./mdns-discovery"
import { subscribe as subscribeMdns } from "./mdns-discovery"
import { enumerateSlash24, getPrivateLocalIps } from "./local-ip"

/**
 * High-level LAN scan that surfaces every cognia desktop server it can
 * find on the user's local network. Drives the mobile pair page's
 * Discover step.
 *
 * Two parallel paths:
 *
 *   1. **mDNS** — `subscribeMdns()` listens for `_cognia._tcp`
 *      advertisements when a Capacitor mDNS plugin is wired in via the
 *      injected loader. Hits carry the server's TLS SPKI
 *      fingerprint in the TXT records, so we can later refuse a different
 *      desktop signing key on reconnect.
 *   2. **IP-segment probe (fallback)** — when mDNS yields no results
 *      within the listening window, we scrape the device's private IPs
 *      via `getPrivateLocalIps()` (WebRTC ICE-candidate trick) and
 *      parallel-probe each `/24` for the cognia 401 signature. Each
 *      probe hit is enriched by a parallel `/api/v1/healthz` call so
 *      we still get the SPKI fingerprint on this path (used by the UI's
 *      mismatch detector).
 *
 * The function is best-effort: it never throws and always returns the
 * deduplicated list of servers it could surface within the time window.
 */

export type DiscoveredServerSource = "paired" | "mdns" | "probe" | "history"

export interface DiscoveredServer {
  /** Stable id used for dedupe — `ip:port`. */
  id: string
  hostname?: string
  ip: string
  port: number
  /** Full `https://{host}:{port}`. */
  baseUrl: string
  source: DiscoveredServerSource
  serverVersion?: string
  /** TLS SPKI hash from mDNS TXT or /healthz. */
  fingerprint?: string
  /** Stable installation id from /healthz — survives cert rotation. */
  serverId?: string
  latencyMs?: number
  discoveredAt: number
}

/**
 * Reduced view of a paired device used for scan-time ranking + multi-port
 * resolution. Mirrors the shape of [`PairedDeviceRow`] without forcing
 * the consumer to import the Dexie type.
 */
export interface PairedSummary {
  ip: string
  /** Optional — defaults to the primary probe port. */
  port?: number
  fingerprint?: string
  label?: string
  lastSeenAt?: number
}

export interface ScanLanOptions {
  /** Caller cancellation — aborting stops mDNS + cancels in-flight probes. */
  signal: AbortSignal
  /** Streamed callback fired the first time a server enters the dedupe map
   *  AND each time the entry is upgraded (probe → probe-with-fingerprint,
   *  probe → mdns, etc.). */
  onFound: (server: DiscoveredServer) => void
  /** Disable the IP-segment probe path entirely. Default true. */
  enableProbeFallback?: boolean
  /** Concurrent fetch ceiling for the probe path. Default 8. */
  probeConcurrency?: number
  /** Wait at least this long for mDNS to surface candidates. Default 5000 ms. */
  mdnsWindowMs?: number
  /** Per-IP fetch timeout. Default 600 ms — a real LAN companion responds
   *  well under 100 ms; anything slower is almost certainly a dead host. */
  perProbeTimeoutMs?: number
  /** Pre-populate the list with previously-paired servers (rendered as `history`). */
  history?: DiscoveredServer[]
  /** Currently-paired devices — surfaced at the top of the list under the
   *  `paired` source tier, and used to expand probe ports for known
   *  desktops (covers dev override ports). */
  paired?: PairedSummary[]
  /** Test seam — fetch implementation. When omitted, Capacitor native uses
   *  `CapacitorHttp.request()` directly (bypassing the broken fetch interceptor
   *  in dev mode) and web falls through to `fetch`. */
  fetchImpl?: typeof fetch
  /** Test seam — mDNS subscription. */
  mdnsSubscribe?: typeof subscribeMdns
  /** Test seam — local-IP enumeration. */
  getLocalIps?: typeof getPrivateLocalIps
  /** Test seam — healthz fetcher. Defaults to the real `fetchHealthz`. */
  healthzFetcher?: typeof fetchHealthz
  /** Primary companion port — 27890. The full probe set
   *  (`PROBE_PORTS`) is only applied to paired/emulator IPs to keep
   *  generic /24 fan-out bounded. */
  port?: number
}

// Mirrors Rust `companion_api::server::DEFAULT_PORT` — 27890, moved out of
// the 789x range because 7890 is the Clash mixed-port default.
const DEFAULT_PORT = 27890

/**
 * Ports the scanner sweeps for paired / emulator IPs. The desktop binds
 * 27890 by default; 7890 stays in the set so phones can rediscover desktops
 * still running a pre-27890 build, and 7891/7900/8443 are the alt-port set
 * the user might pick when the default is held by another process.
 * Generic /24 IPs only get the primary port — see
 * [`resolveProbePorts`].
 */
export const PROBE_PORTS: readonly number[] = [27890, 7890, 7891, 7900, 8443]

/**
 * Android emulator host gateway alias. The emulator's NAT'd subnet
 * (10.0.2.0/24) has no real hosts other than the gateway at 10.0.2.2;
 * scanning the full /24 wastes 254 probes the WebView can't answer.
 * `pickProbeTargets` short-circuits to this single IP whenever the
 * device only exposes addresses in that subnet (typically guest IP
 * 10.0.2.15).
 */
const ANDROID_EMULATOR_HOST_IP = "10.0.2.2"

export async function scanLan(opts: ScanLanOptions): Promise<DiscoveredServer[]> {
  const {
    signal,
    onFound,
    enableProbeFallback = true,
    probeConcurrency = 8,
    mdnsWindowMs = 5_000,
    perProbeTimeoutMs = 600,
    history = [],
    paired = [],
    fetchImpl,
    mdnsSubscribe = subscribeMdns,
    getLocalIps = getPrivateLocalIps,
    healthzFetcher = fetchHealthz,
    port = DEFAULT_PORT,
  } = opts

  const dedupe = new Map<string, DiscoveredServer>()

  const emit = (server: DiscoveredServer) => {
    const existing = dedupe.get(server.id)
    if (existing) {
      const sameOrLowerSource = rankSource(existing.source) >= rankSource(server.source)
      // Allow re-emit for fingerprint enrichment within the same source
      // tier: probe hit lands first without fp, healthz follow-up brings
      // the SPKI hash. The UI listener relies on this update.
      const isPureUpgrade = sameOrLowerSource && !existing.fingerprint && !!server.fingerprint
      if (sameOrLowerSource && !isPureUpgrade) return
    }
    dedupe.set(server.id, server)
    onFound(server)
  }

  // Paired devices are layered first so their `paired` rank wins
  // re-emits from probe/mdns hits on the same id.
  for (const p of paired) {
    const resolvedPort = p.port ?? port
    emit(pairedToDiscovered(p, resolvedPort))
  }
  for (const h of history) {
    emit({ ...h, source: "history" })
  }
  if (signal.aborted) return Array.from(dedupe.values())

  let unsub: (() => void | Promise<void>) | undefined
  try {
    unsub = await mdnsSubscribe((svc) => emit(serverFromMdns(svc, port)))
  } catch {
    unsub = undefined
  }

  const probeTask = (async () => {
    if (!enableProbeFallback) return
    const ips = await getLocalIps({ signal, timeoutMs: 1_200 })
    if (signal.aborted || ips.length === 0) return
    const ipTargets = pickProbeTargets(ips)
    const targets = expandToPortTargets(ipTargets, paired, port)
    const enrichments: Promise<void>[] = []
    await runWithConcurrency(targets, probeConcurrency, async (t) => {
      if (signal.aborted) return
      const hit = await probeServer(t.ip, t.port, signal, perProbeTimeoutMs, fetchImpl)
      if (!hit) return
      emit(hit)
      // Fingerprint enrichment via healthz — scheduled on a side promise
      // so concurrent probes can keep dispatching, but awaited at the end
      // of probeTask to prevent post-return emits leaking into onFound.
      enrichments.push(
        (async () => {
          const hz = await healthzFetcher(hit.baseUrl, {
            signal,
            timeoutMs: perProbeTimeoutMs,
            fetchImpl,
          })
          if (!hz) return
          emit({
            ...hit,
            fingerprint: hz.fingerprint,
            serverId: hz.serverId,
            serverVersion: hit.serverVersion ?? hz.version,
          })
        })()
      )
    })
    await Promise.allSettled(enrichments)
  })()

  const mdnsWindow = new Promise<void>((resolve) => setTimeout(resolve, mdnsWindowMs))
  const abortPromise = new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
  await Promise.race([Promise.all([probeTask, mdnsWindow]), abortPromise])

  if (unsub) {
    try {
      await unsub()
    } catch {
      // Best-effort cleanup.
    }
  }

  return Array.from(dedupe.values())
}

/**
 * Decide which IPs to probe given the device's private addresses.
 *
 * Default: fan out each address into its full /24. On the Android emulator
 * every /24 probe lands inside the NAT'd subnet that has no real hosts —
 * the desktop is reachable only via the `10.0.2.2` gateway alias.
 * Probing 254 dead IPs adds ~24 s of background fetch + AbortController
 * churn, which is the lag users feel when they land on the Discover step.
 * Short-circuit by probing the gateway alone.
 *
 * Detection covers two cases:
 *   1. The only IP returned is the emulator's guest IP (10.0.2.15).
 *   2. Every IP lies in the 10.0.2.x range (emulator virtual subnet).
 *      This happens when WebRTC ICE returns the gateway (10.0.2.2) or
 *      other virtual interface addresses.
 */
export function pickProbeTargets(ips: readonly string[]): string[] {
  if (ips.length === 0) return []
  // Short-circuit when every IP lies in the emulator's virtual subnet.
  // This covers: [10.0.2.15], [10.0.2.2], [10.0.2.2, 10.0.2.3], etc.
  // Mixed lists (e.g. [10.0.2.15, 192.168.1.7]) still get the full /24 probe.
  const allInEmulatorSubnet = ips.every((ip) => ip.startsWith("10.0.2."))
  if (allInEmulatorSubnet) {
    return [ANDROID_EMULATOR_HOST_IP]
  }
  return Array.from(new Set(ips.flatMap(enumerateSlash24)))
}

/**
 * Resolve which ports to try for a given IP. Paired IPs and the Android
 * emulator host alias get the full [`PROBE_PORTS`] set so a dev override
 * port still surfaces; generic /24 IPs only get the primary port to keep
 * the fan-out bounded.
 */
export function resolveProbePorts(
  ip: string,
  paired: readonly PairedSummary[],
  primaryPort: number
): number[] {
  const set = new Set<number>([primaryPort])
  const pairedMatch = paired.find((p) => p.ip === ip)
  if (pairedMatch || ip === ANDROID_EMULATOR_HOST_IP) {
    for (const p of PROBE_PORTS) set.add(p)
  }
  return Array.from(set)
}

interface ProbeTarget {
  ip: string
  port: number
}

function expandToPortTargets(
  ips: readonly string[],
  paired: readonly PairedSummary[],
  primaryPort: number
): ProbeTarget[] {
  const out: ProbeTarget[] = []
  for (const ip of ips) {
    for (const p of resolveProbePorts(ip, paired, primaryPort)) {
      out.push({ ip, port: p })
    }
  }
  return out
}

/**
 * Canonical source-tier ranking. Higher wins on dedupe re-emit. Exported
 * so the discover step + scan sheet don't fork their own copies and
 * silently drop the "paired" tier (which they would default to 1).
 */
export function rankSource(source: DiscoveredServerSource): number {
  if (source === "paired") return 4
  if (source === "mdns") return 3
  if (source === "probe") return 2
  return 1
}

function pairedToDiscovered(p: PairedSummary, port: number): DiscoveredServer {
  return {
    id: `${p.ip}:${port}`,
    hostname: p.label,
    ip: p.ip,
    port,
    baseUrl: `https://${p.ip}:${port}`,
    source: "paired",
    fingerprint: p.fingerprint,
    discoveredAt: p.lastSeenAt ?? Date.now(),
  }
}

function serverFromMdns(svc: DiscoveredService, defaultPort: number): DiscoveredServer {
  const port = svc.port || defaultPort
  const host = svc.hostname || svc.ip
  return {
    id: `${svc.ip}:${port}`,
    hostname: svc.hostname || svc.name,
    ip: svc.ip,
    port,
    baseUrl: `https://${host}:${port}`,
    source: "mdns",
    serverVersion: svc.txt?.ver,
    fingerprint: svc.txt?.fp,
    discoveredAt: Date.now(),
  }
}

async function probeServer(
  ip: string,
  port: number,
  signal: AbortSignal,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined
): Promise<DiscoveredServer | null> {
  if (signal.aborted) return null
  // Companion server always terminates HTTPS (src-tauri/src/companion_api/server.rs
  // uses axum_server::from_tcp_rustls).  The probe must speak TLS; plain HTTP
  // causes an EOF because the server replies with TLS handshake bytes.
  const baseUrl = `https://${ip}:${port}`
  const url = `${baseUrl}/api/v1/whoami`
  const start = nowMs()

  // When on Capacitor native, bypass the broken fetch interceptor
  // (which 404s in dev mode) and call CapacitorHttp directly.
  const cap = !fetchImpl ? getCapacitorHttp() : null
  if (cap) {
    return probeWithCapacitorHttp(cap, url, baseUrl, ip, port, signal, timeoutMs, start)
  }

  // Web / test path — standard fetch.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await (fetchImpl ?? fetch)(url, {
      method: "GET",
      signal: combineAbortSignals(signal, controller.signal),
      mode: "cors",
      credentials: "omit",
    })
    return await evaluateProbeResponse(response, baseUrl, ip, port, start)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function probeWithCapacitorHttp(
  cap: CapacitorHttpPlugin,
  url: string,
  baseUrl: string,
  ip: string,
  port: number,
  signal: AbortSignal,
  timeoutMs: number,
  start: number
): Promise<DiscoveredServer | null> {
  const resp = await capacitorHttpGet(cap, url, {
    signal,
    timeoutMs,
    serverTrustMode: "self-signed",
  })
  if (!resp) return null
  const responseLike = {
    status: resp.status,
    json: async () =>
      JSON.parse(typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data)),
  }
  return evaluateProbeResponse(responseLike as Response, baseUrl, ip, port, start)
}

async function evaluateProbeResponse(
  response: Response,
  baseUrl: string,
  ip: string,
  port: number,
  start: number
): Promise<DiscoveredServer | null> {
  if (response.status !== 401) return null
  const body = await safeJson(response)
  if (!isObject(body)) return null
  if (!("code" in body) && !("message" in body)) return null
  const latencyMs = Math.round(nowMs() - start)
  const version = typeof body.version === "string" ? (body.version as string) : undefined
  return {
    id: `${ip}:${port}`,
    ip,
    port,
    baseUrl,
    source: "probe",
    serverVersion: version,
    latencyMs,
    discoveredAt: Date.now(),
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return
  let cursor = 0
  const lanes = Math.max(1, Math.min(concurrency, items.length))
  const next = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++
      await worker(items[idx])
    }
  }
  await Promise.all(Array.from({ length: lanes }, () => next()))
}

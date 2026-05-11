"use client"

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
 *      parallel-probe each `/24` for the cognia 401 signature. No TLS
 *      pin is available on this path; the UI prompts the user to confirm
 *      via QR for first-time bind.
 *
 * The function is best-effort: it never throws and always returns the
 * deduplicated list of servers it could surface within the time window.
 */

export type DiscoveredServerSource = "mdns" | "probe" | "history"

export interface DiscoveredServer {
  /** Stable id used for dedupe — `ip:port`. */
  id: string
  hostname?: string
  ip: string
  port: number
  /** Full `https://{host}:{port}` (or `http://` for the probe path). */
  baseUrl: string
  source: DiscoveredServerSource
  serverVersion?: string
  /** TLS SPKI hash, only populated by mDNS hits. */
  fingerprint?: string
  latencyMs?: number
  discoveredAt: number
}

export interface ScanLanOptions {
  /** Caller cancellation — aborting stops mDNS + cancels in-flight probes. */
  signal: AbortSignal
  /** Streamed callback fired the first time a server enters the dedupe map. */
  onFound: (server: DiscoveredServer) => void
  /** Disable the IP-segment probe path entirely. Default true. */
  enableProbeFallback?: boolean
  /** Concurrent fetch ceiling for the probe path. Default 16. */
  probeConcurrency?: number
  /** Wait at least this long for mDNS to surface candidates. Default 5000 ms. */
  mdnsWindowMs?: number
  /** Per-IP fetch timeout. Default 1500 ms. */
  perProbeTimeoutMs?: number
  /** Pre-populate the list with previously-paired servers (rendered as `history`). */
  history?: DiscoveredServer[]
  /** Test seam — fetch implementation. */
  fetchImpl?: typeof fetch
  /** Test seam — mDNS subscription. */
  mdnsSubscribe?: typeof subscribeMdns
  /** Test seam — local-IP enumeration. */
  getLocalIps?: typeof getPrivateLocalIps
  /** Default companion port — 7890. */
  port?: number
}

const DEFAULT_PORT = 7890

export async function scanLan(opts: ScanLanOptions): Promise<DiscoveredServer[]> {
  const {
    signal,
    onFound,
    enableProbeFallback = true,
    probeConcurrency = 16,
    mdnsWindowMs = 5_000,
    perProbeTimeoutMs = 1_500,
    history = [],
    fetchImpl = typeof fetch !== "undefined" ? fetch : undefined,
    mdnsSubscribe = subscribeMdns,
    getLocalIps = getPrivateLocalIps,
    port = DEFAULT_PORT,
  } = opts

  const dedupe = new Map<string, DiscoveredServer>()

  const emit = (server: DiscoveredServer) => {
    const existing = dedupe.get(server.id)
    if (existing && rank(existing.source) >= rank(server.source)) return
    dedupe.set(server.id, server)
    onFound(server)
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
    if (!enableProbeFallback || !fetchImpl) return
    const ips = await getLocalIps({ signal, timeoutMs: 1_200 })
    if (signal.aborted || ips.length === 0) return
    const targets = Array.from(new Set(ips.flatMap(enumerateSlash24)))
    await runWithConcurrency(targets, probeConcurrency, async (ip) => {
      if (signal.aborted) return
      const hit = await probeServer(ip, port, signal, perProbeTimeoutMs, fetchImpl)
      if (hit) emit(hit)
    })
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

function rank(source: DiscoveredServerSource): number {
  if (source === "mdns") return 3
  if (source === "probe") return 2
  return 1
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
  fetchImpl: typeof fetch
): Promise<DiscoveredServer | null> {
  if (signal.aborted) return null
  const baseUrl = `http://${ip}:${port}`
  const url = `${baseUrl}/api/v1/whoami`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const start = nowMs()
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: combineSignals(signal, controller.signal),
      mode: "cors",
      credentials: "omit",
    })
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
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Merge two AbortSignals into one. Prefers the platform `AbortSignal.any`
 * (Node 20.3+, recent browsers) and falls back to the local controller's
 * signal in environments without it — that path skips parent-abort
 * propagation, which is fine for our scan loop because the worker also
 * checks `signal.aborted` between probes.
 */
function combineSignals(parent: AbortSignal, local: AbortSignal): AbortSignal {
  type AbortSignalCtor = typeof AbortSignal & {
    any?: (signals: readonly AbortSignal[]) => AbortSignal
  }
  const ctor = AbortSignal as AbortSignalCtor
  if (typeof ctor.any === "function") {
    return ctor.any([parent, local])
  }
  return local
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

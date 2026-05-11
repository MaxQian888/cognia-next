"use client"

/**
 * mDNS / Bonjour discovery (Wave 1.5 / M2.9).
 *
 * Two roles:
 *   - **Mobile**: scans for `_cognia._tcp` services on the LAN and surfaces
 *     them to the pair page's "附近设备" list. No Capacitor mDNS plugin is
 *     currently wired — `defaultMobileLoader` rejects, `subscribe()` returns
 *     a no-op, and lan-scanner falls back to the IP-segment probe.
 *   - **Desktop**: advertises via Rust (`src-tauri/src/companion_api/mdns.rs`).
 *     The Tauri command surface is kept here so any TS code that wants to
 *     start/stop the broadcaster has one place to import.
 */

export interface DiscoveredService {
  /** Display name pulled from the service instance, e.g. `cognia-AB12CD`. */
  name: string
  /** Resolved hostname for the advertising machine. */
  hostname: string
  /** First IP (v4 preferred) the service resolved to. */
  ip: string
  /** Service port. */
  port: number
  /** TXT records, decoded as plain strings. */
  txt: Record<string, string>
}

interface MdnsScannerShape {
  startScan(opts: { serviceType: string }): Promise<void>
  stopScan(): Promise<void>
  addListener(
    event: "serviceFound",
    handler: (svc: DiscoveredService) => void
  ): Promise<{ remove(): Promise<void> | void }>
}

export type MdnsLoader = () => Promise<MdnsScannerShape>

const defaultMobileLoader: MdnsLoader = async () => {
  throw new Error("mDNS plugin not configured")
}

const SERVICE_TYPE = "_cognia._tcp"

export type Unsubscribe = () => void

/**
 * Subscribe to discovered cognia services. Returns a no-op unsubscriber on
 * non-mobile platforms. The handler may be called many times — dedupe by
 * `hostname:port` if the caller wants a stable list.
 */
export async function subscribe(
  handler: (svc: DiscoveredService) => void,
  loader: MdnsLoader = defaultMobileLoader
): Promise<Unsubscribe> {
  let scanner: MdnsScannerShape
  try {
    scanner = await loader()
  } catch {
    return () => {}
  }
  try {
    const listener = await scanner.addListener("serviceFound", handler)
    await scanner.startScan({ serviceType: SERVICE_TYPE })
    return async () => {
      try {
        await scanner.stopScan()
      } catch {
        // Best effort.
      }
      void listener.remove()
    }
  } catch {
    return () => {}
  }
}

/**
 * Tauri-side broadcaster control. Calls into the Rust `mdns_broadcaster_*`
 * commands (Wave 1.5). Returns `false` on web (no-op).
 */
export interface BroadcastOptions {
  port: number
  appVersion: string
  tlsFingerprint: string
  /** Defaults to `cognia-<random>`. */
  instanceName?: string
}

export interface TauriInvoker {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>
}

const tauriInvoker: () => Promise<TauriInvoker | null> = async () => {
  try {
    if (typeof window === "undefined") return null
    if (!("__TAURI_INTERNALS__" in window)) return null
    const moduleId = "@tauri-apps/api/core"
    const mod = (await import(/* webpackIgnore: true */ moduleId)) as TauriInvoker
    return mod
  } catch {
    return null
  }
}

export async function startBroadcast(
  opts: BroadcastOptions,
  loader: () => Promise<TauriInvoker | null> = tauriInvoker
): Promise<
  | { kind: "started"; fullname: string }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }
> {
  const invoker = await loader()
  if (!invoker) return { kind: "unsupported" }
  try {
    const fullname = await invoker.invoke<string>("companion_mdns_start", {
      port: opts.port,
      appVersion: opts.appVersion,
      tlsFingerprint: opts.tlsFingerprint,
      instanceName: opts.instanceName,
    })
    return { kind: "started", fullname }
  } catch (err: unknown) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function stopBroadcast(
  loader: () => Promise<TauriInvoker | null> = tauriInvoker
): Promise<{ kind: "stopped" } | { kind: "unsupported" }> {
  const invoker = await loader()
  if (!invoker) return { kind: "unsupported" }
  try {
    await invoker.invoke("companion_mdns_stop")
    return { kind: "stopped" }
  } catch {
    return { kind: "stopped" }
  }
}

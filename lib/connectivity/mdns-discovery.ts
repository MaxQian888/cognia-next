"use client"

/**
 * mDNS / Bonjour discovery (Wave 1.5 / M2.9).
 *
 * Two roles:
 *   - **Mobile**: scans for `_cognia._tcp` services on the LAN and surfaces
 *     them to the pair page's "附近设备" list, via `capacitor-zeroconf`
 *     (registered at mobile boot from `PluginHeaders`, see
 *     `lib/capacitor/register-plugins.ts`). When the plugin is absent
 *     `subscribe()` degrades to a no-op and `lan-scanner` falls back to the
 *     IP-segment probe.
 *   - **Desktop**: advertises via Rust (`src-tauri/src/companion_api/mdns.rs`),
 *     and browses via `lib/connectivity/mdns-browse.ts`. The Tauri command
 *     surface is kept here so any TS code that wants to start/stop the
 *     broadcaster has one place to import.
 */

import { makeDefaultLoader } from "@/lib/capacitor/_shared"
import { isTauri } from "@/lib/platform/detect"

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

const SERVICE_TYPE = "_cognia._tcp"

/**
 * Shape of the upstream `capacitor-zeroconf` plugin we care about. Kept
 * minimal so the dynamic-import never pulls in extra surface, and so this
 * module remains testable without the native side present.
 */
export interface ZeroconfWatchResult {
  /** `added` = seen but unresolved; `resolved` = addresses available. */
  action: "added" | "removed" | "resolved"
  service: {
    name?: string
    hostname?: string
    ipv4Addresses?: string[]
    ipv6Addresses?: string[]
    port?: number
    txtRecord?: Record<string, string>
  }
}

interface ZeroconfPluginShape {
  watch(opts: { type: string; domain: string }): Promise<void>
  unwatch(opts?: { type: string; domain: string }): Promise<void>
  addListener(
    event: "discover",
    handler: (result: ZeroconfWatchResult) => void
  ): Promise<{ remove(): Promise<void> | void }>
}

// Resolve through the shared loader: window.Capacitor.Plugins.ZeroConf first
// (registered at mobile boot from PluginHeaders), then the dynamic import.
// NOTE the casing — the package exports and registers as "ZeroConf".
const loadZeroconf = makeDefaultLoader<ZeroconfPluginShape>("capacitor-zeroconf", "ZeroConf")

/**
 * Default mobile loader — adapts `capacitor-zeroconf`'s
 * `watch`/`addListener("discover")` surface to our internal
 * `MdnsScannerShape`. The shared loader throws on web / Tauri so
 * `subscribe()` returns a no-op for those platforms.
 *
 * The plugin fires `discover` with `{ action, service }`; only `resolved`
 * events carry addresses, so `added`/`removed` are dropped here — callers
 * want connectable endpoints, not liveness churn.
 *
 * The plugin's `txtRecord.fp` carries the desktop's SHA-256 SPKI fingerprint
 * we use for TLS pinning before the first request.
 */
const defaultMobileLoader: MdnsLoader = async () => {
  const plugin = await loadZeroconf()

  // Split `_cognia._tcp` into `type` + assume `.local.` domain so the
  // plugin's IDL matches.
  return {
    async startScan({ serviceType }) {
      await plugin.watch({ type: serviceType, domain: "local." })
    },
    async stopScan() {
      await plugin.unwatch({ type: SERVICE_TYPE, domain: "local." })
    },
    async addListener(_event, handler) {
      const sub = await plugin.addListener("discover", (result) => {
        if (result.action !== "resolved") return
        const svc = result.service
        const ip = svc.ipv4Addresses?.[0] ?? svc.ipv6Addresses?.[0] ?? ""
        handler({
          name: svc.name ?? "cognia",
          hostname: svc.hostname ?? svc.name ?? ip,
          ip,
          port: svc.port ?? 0,
          txt: svc.txtRecord ?? {},
        })
      })
      return sub
    },
  }
}

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
    if (!isTauri()) return null
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

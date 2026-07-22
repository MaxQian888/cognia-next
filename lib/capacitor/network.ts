"use client"

import { makeDefaultLoader, withPlugin } from "./_shared"

/**
 * `@capacitor/network` wrapper. Surfaces a current network status and a
 * `subscribe` helper that the outbound queue + offline banner consume.
 *
 * On non-mobile platforms the wrapper falls back to `navigator.onLine` and
 * the `online` / `offline` window events so the UI keeps working.
 */

export type ConnectionType = "wifi" | "cellular" | "none" | "unknown"

export interface NetworkStatus {
  connected: boolean
  connectionType: ConnectionType
}

interface NetworkShape {
  getStatus(): Promise<NetworkStatus>
  addListener(
    event: "networkStatusChange",
    handler: (status: NetworkStatus) => void
  ): Promise<{ remove(): Promise<void> } | { remove(): void }>
}

export type NetworkLoader = () => Promise<NetworkShape>

const defaultLoader: NetworkLoader = makeDefaultLoader<NetworkShape>(
  "@capacitor/network",
  "Network"
)

export type GetStatusOutcome =
  | { kind: "ok"; status: NetworkStatus }
  | { kind: "fallback"; status: NetworkStatus }
  | { kind: "error"; message: string }

export async function getStatus(loader: NetworkLoader = defaultLoader): Promise<GetStatusOutcome> {
  const result = await withPlugin(loader, async (net) => {
    const status = await net.getStatus()
    return { kind: "ok" as const, status }
  })
  if (result && "kind" in result && result.kind === "ok") return result
  if (result && "kind" in result && result.kind === "error") return result
  // Unsupported → fall back to navigator.onLine
  return {
    kind: "fallback",
    status: webStatusFallback(),
  }
}

function webStatusFallback(): NetworkStatus {
  // Node 26 ships a global `navigator` WITHOUT `onLine`, so the old
  // `typeof navigator !== "undefined"` check would hand back `undefined` and
  // report a permanently disconnected network off-browser. Only trust the flag
  // when it is really a boolean; otherwise assume connected, as before.
  const connected = typeof navigator?.onLine === "boolean" ? navigator.onLine : true
  return {
    connected,
    connectionType: connected ? "unknown" : "none",
  }
}

export type Unsubscribe = () => void

export async function subscribe(
  handler: (status: NetworkStatus) => void,
  loader: NetworkLoader = defaultLoader
): Promise<Unsubscribe> {
  let pluginListener: { remove: () => void | Promise<void> } | null = null
  try {
    const net = await loader()
    const listener = await net.addListener("networkStatusChange", handler)
    pluginListener = listener as { remove: () => void | Promise<void> }
  } catch {
    // Web fallback: window online/offline events.
    if (typeof window === "undefined") return () => {}
    const onChange = () => handler(webStatusFallback())
    window.addEventListener("online", onChange)
    window.addEventListener("offline", onChange)
    return () => {
      window.removeEventListener("online", onChange)
      window.removeEventListener("offline", onChange)
    }
  }
  return () => {
    void pluginListener?.remove()
  }
}

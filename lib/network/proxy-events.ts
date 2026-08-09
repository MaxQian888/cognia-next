/** Renderer-local signal emitted only after Rust atomically applies proxy policy. */
export const NETWORK_PROXY_APPLIED_EVENT = "cognia:network-proxy-applied"

export function notifyNetworkProxyApplied(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(NETWORK_PROXY_APPLIED_EVENT))
  }
}

/**
 * `stores/system` — historical entry point for the proxy store. The full
 * implementation moved to `stores/network-proxy/` once the Settings →
 * Network Proxy section landed; this barrel re-exports the legacy shape so
 * callers (`lib/network/proxy-fetch.ts`) keep working without churn.
 */

export {
  applyProxyToRust,
  getActiveProxyUrl,
  getNetworkProxy,
  resetApplyProxyDedupeForTesting,
  useNetworkProxy,
  useProxyStore,
  type ProxyConfig,
  type ProxyStoreState,
} from "@/stores/network-proxy"

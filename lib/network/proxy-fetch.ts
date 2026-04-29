/**
 * Proxy-aware fetch shim.
 *
 * Cognia ships a richer `proxyFetch` that tunnels HTTP traffic through a
 * Tauri-side proxy when a corporate proxy is configured. cognia-next does
 * not yet have that infrastructure; for now we delegate directly to the
 * platform `fetch`. Replace later if/when proxy support is added.
 */

export const proxyFetch: typeof fetch = (...args) => fetch(...args)

export default proxyFetch

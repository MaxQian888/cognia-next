/**
 * Browser-side empty stub for Node built-in modules (`fs`, `path`, etc.)
 * that get pulled into client bundles by libraries with optional Node-only
 * code paths.
 *
 * Used via `turbopack.resolveAlias` with the `browser` condition. The real
 * modules are still available in Jest / Tauri Rust / sidecar code paths
 * because those don't run through Turbopack's browser resolution.
 */

const browserNotSupported = (api: string) => () => {
  throw new Error(
    `Node built-in API "${api}" is not available in the browser/Tauri webview runtime.`
  )
}

const handler: ProxyHandler<Record<string, unknown>> = {
  get(target, prop) {
    if (prop in target) return target[prop as string]
    if (prop === "default" || typeof prop === "symbol") return undefined
    return browserNotSupported(String(prop))
  },
}

const stub = new Proxy({} as Record<string, unknown>, handler)

export default stub
export const promises = stub
export const constants = stub

/**
 * Extensions' outbound traffic goes through the user's proxy.
 *
 * The desktop host starts this process with the proxy it applied in its
 * environment (`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`, mirrored by
 * `cognia-net`'s `proxy_config`), including the deliberate dead end it sets
 * while the proxy settings are still loading. Node does not read those on its
 * own, so the host installs them as the global proxy for `fetch`, `WebSocket`
 * and the `http` / `https` modules extensions load.
 *
 * Proxy settings applied after the host started reach it when it restarts.
 */

import * as http from "node:http"

/** Where traffic goes when the proxy settings are unusable: nowhere. */
export const DEAD_END_PROXY = "http://127.0.0.1:9"

type SetGlobalProxyFromEnv = (env?: NodeJS.ProcessEnv) => () => void

/**
 * Install the proxy in `env` for every outbound client in this process.
 * Returns how the traffic will go. Fails closed: proxy settings Node cannot
 * use send traffic to {@link DEAD_END_PROXY} rather than straight out.
 */
export function installEnvProxy(
  env: NodeJS.ProcessEnv = process.env,
  setGlobalProxyFromEnv: SetGlobalProxyFromEnv | null = (
    http as unknown as { setGlobalProxyFromEnv?: SetGlobalProxyFromEnv }
  ).setGlobalProxyFromEnv ?? null,
  warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`)
): "proxy" | "direct" | "dead-end" | "unproxied" {
  const proxied = Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)
  if (!proxied) return "direct"
  if (!setGlobalProxyFromEnv) {
    // Node before 24.5 has no global proxy; the host requires Node 26.
    warn(
      "[vscode-ext-host] ERROR this Node cannot use a proxy; extension traffic will not go through it"
    )
    return "unproxied"
  }
  try {
    setGlobalProxyFromEnv(env)
    return "proxy"
  } catch (error) {
    warn(
      `[vscode-ext-host] ERROR the proxy settings are unusable (${
        error instanceof Error ? error.message : String(error)
      }); extensions cannot reach the network`
    )
    setGlobalProxyFromEnv({ HTTP_PROXY: DEAD_END_PROXY, HTTPS_PROXY: DEAD_END_PROXY })
    return "dead-end"
  }
}

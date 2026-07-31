/**
 * Provider-core runtime adapters — the bridge that lets `@cognia/provider-core`
 * reach the network from the Tauri renderer.
 *
 * The packaged desktop shell serves the renderer under a static CSP whose
 * `connect-src` is `'self' ipc: http://ipc.localhost ws: wss:`
 * (`src-tauri/tauri.conf.json`; `tauri.macos.conf.json` adds no override). No
 * `http:` scheme means a renderer `fetch("http://localhost:11434/api/tags")` is
 * blocked before it leaves the WebView — loopback is not `'self'`. This is not
 * a hypothesis: the same CSP already silently killed the OTLP, Langfuse and
 * generic `remote` log transports, which shipped for months without ever
 * emitting a byte.
 *
 * `pnpm dev` runs without a CSP, which is why every local-provider surface
 * looks healthy in development and is dead in the packaged app.
 *
 * The escape hatch is Rust: `proxyFetch` funnels the request through the
 * `proxy_http_request` Tauri command, and reqwest is bound by neither CSP nor
 * CORS. Until a host installs these adapters, `provider-core` falls back to
 * `defaultProxyFetch` — a bare `fetch` — and every local-provider management
 * call is CSP-blocked on the desktop.
 *
 * The boot-time `ProviderCoreRuntimeInitializer` installs this exactly once;
 * `lib/headless/runtimes/initializers.ts` does the same for the headless brain
 * host. Mirrors `lib/claude/routing-runtime-deps.ts`.
 */

import type { ProviderCoreRuntimeAdapters } from "@cognia/provider-core/providers/runtime-adapters"
import { loggers } from "@cognia/logging"

import { isTauri } from "@/lib/tauri"
import { proxyFetch } from "@/lib/network/proxy-fetch"

/**
 * Build the host-backed provider-core runtime adapters.
 *
 * `proxyFetch` is passed through WITHOUT `blockPrivateHosts`. That flag is the
 * SSRF guard the Rust side reads as `blockPrivate`; omitting it leaves
 * `block_private` as `None`, and `proxy_config/commands.rs` only rejects
 * private hosts on `Some(true)`. Loopback must stay reachable here — a local
 * inference server on `127.0.0.1` IS the target, so turning the guard on would
 * block exactly the traffic this bridge exists to carry.
 */
export function buildProviderCoreRuntimeAdapters(): ProviderCoreRuntimeAdapters {
  return {
    isTauri,
    proxyFetch,
    loggers: { ai: loggers.ai },
  }
}

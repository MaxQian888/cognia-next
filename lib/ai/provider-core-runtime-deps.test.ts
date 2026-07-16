import { buildProviderCoreRuntimeAdapters } from "./provider-core-runtime-deps"
import { isTauri } from "@/lib/tauri"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { loggers } from "@cognia/logging"

describe("buildProviderCoreRuntimeAdapters", () => {
  it("wires the host's Tauri detector", () => {
    expect(buildProviderCoreRuntimeAdapters().isTauri).toBe(isTauri)
  })

  it("wires the ai logger so provider-core stops swallowing into its noop logger", () => {
    expect(buildProviderCoreRuntimeAdapters().loggers?.ai).toBe(loggers.ai)
  })

  /**
   * The whole point of the bridge: provider-core's own default is a bare
   * `fetch`, which the packaged shell's CSP (`connect-src` carries no `http:`)
   * blocks before it leaves the WebView. `proxyFetch` routes through the Rust
   * `proxy_http_request` command, and reqwest is bound by neither CSP nor CORS.
   *
   * Identity — not merely "is a function" — is the assertion that matters.
   * `blockPrivateHosts` is the per-request SSRF guard the Rust side reads as
   * `blockPrivate`; a wrapper that injected it would make loopback unreachable
   * and kill every local inference server, i.e. exactly the traffic this
   * bridge exists to carry. An un-wrapped pass-through has nowhere to inject
   * it, so pinning identity pins that guarantee too.
   */
  it("routes provider-core network calls through the Rust-backed proxy fetch, un-wrapped", () => {
    expect(buildProviderCoreRuntimeAdapters().proxyFetch).toBe(proxyFetch)
  })
})

/**
 * Plugin network egress allowlist — renderer/browser-path enforcement.
 *
 * The desktop (Tauri) path already enforces a per-plugin egress allowlist in
 * Rust (`src-tauri/src/plugin_api/mod.rs:network_host_allowed`). In web and
 * mobile (Capacitor) mode there is no Rust host, so `ctx.network` fetches go
 * straight to the browser `fetch()`. This module mirrors the Rust matcher
 * exactly so the same `manifest.networkAccess.allowedDomains` clamp applies on
 * every platform, closing the web/mobile exfiltration hole.
 *
 * Keep the matching semantics in lockstep with the Rust implementation:
 *   - host is trimmed, trailing dots stripped, lowercased; empty host → deny
 *   - a plugin with no `allowedDomains` declaration is DENIED (fail-closed)
 *     under every posture — a `network:fetch` grant alone no longer implies
 *     unrestricted egress; `["*"]` is the explicit opt-in
 *   - `["*"]` allows any host
 *   - `["none"]`, `[]`, or only-blank entries deny all
 *   - otherwise the host must equal, or be a subdomain of, an entry
 */

/** Host security posture (see `pluginSecurityPosture` setting). */
export type PluginSecurityPosture = "strict" | "balanced"

/** The `manifest.networkAccess` block (subset this module cares about). */
export interface NetworkAllowlist {
  allowedDomains?: string[]
  reasoning?: string
}

export type EgressReason =
  "no-declaration" | "strict-no-declaration" | "wildcard" | "host-match" | "host-denied" | "bad-url"

export interface EgressDecision {
  allowed: boolean
  reason: EgressReason
}

/**
 * Mirror of the Rust `network_host_allowed` matcher. `host` must equal, or be a
 * subdomain of, one of the (non-blank, non-"none") `patterns`; `"*"` allows any.
 */
export function matchHost(host: string, patterns: string[]): boolean {
  const h = host.trim().replace(/\.+$/, "").toLowerCase()
  if (!h) return false
  if (patterns.some((entry) => entry.trim() === "*")) return true
  return patterns.some((entry) => {
    const e = entry.trim().replace(/^\.+/, "").toLowerCase()
    return e.length > 0 && e !== "none" && (h === e || h.endsWith(`.${e}`))
  })
}

/** Extract a hostname from a URL string; `null` when it cannot be parsed. */
export function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/**
 * Decide whether `url` is a permitted egress target for a plugin whose manifest
 * declared `networkAccess`. Pure — returns a decision, never throws.
 */
export function evaluateEgress(
  url: string,
  networkAccess: NetworkAllowlist | undefined,
  posture: PluginSecurityPosture = "balanced"
): EgressDecision {
  const host = hostFromUrl(url)
  if (host === null) return { allowed: false, reason: "bad-url" }

  const domains = networkAccess?.allowedDomains
  if (!domains) {
    // No declaration: deny under every posture (fail-closed) — matches the
    // Rust host gate and the webview CSP. `["*"]` is the explicit opt-in to
    // unrestricted egress.
    return posture === "strict"
      ? { allowed: false, reason: "strict-no-declaration" }
      : { allowed: false, reason: "no-declaration" }
  }

  if (domains.some((entry) => entry.trim() === "*")) {
    return { allowed: true, reason: "wildcard" }
  }

  return matchHost(host, domains)
    ? { allowed: true, reason: "host-match" }
    : { allowed: false, reason: "host-denied" }
}

/** Thrown by {@link assertEgressAllowed} when an egress target is not allowed. */
export class PluginEgressError extends Error {
  readonly pluginId: string
  readonly url: string
  readonly host: string
  readonly reason: EgressReason

  constructor(pluginId: string, url: string, host: string, reason: EgressReason) {
    super(`network egress to ${host} is not in plugin ${pluginId}'s allowedDomains`)
    this.name = "PluginEgressError"
    this.pluginId = pluginId
    this.url = url
    this.host = host
    this.reason = reason
  }
}

/**
 * Enforce the egress allowlist for a renderer-side plugin fetch. Throws
 * {@link PluginEgressError} when the target host is not permitted.
 */
export function assertEgressAllowed(
  pluginId: string,
  url: string,
  networkAccess: NetworkAllowlist | undefined,
  posture: PluginSecurityPosture = "balanced"
): void {
  const decision = evaluateEgress(url, networkAccess, posture)
  if (!decision.allowed) {
    throw new PluginEgressError(pluginId, url, hostFromUrl(url) ?? url, decision.reason)
  }
}

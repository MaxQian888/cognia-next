/**
 * Plugin security posture resolver.
 *
 * The posture (`balanced` | `strict`) controls how hard the host clamps plugin
 * capabilities — most notably whether a plugin that holds `network:fetch` but
 * declared NO `networkAccess.allowedDomains` is left unrestricted (`balanced`,
 * the historical default) or denied (`strict`).
 *
 * The live value comes from the global settings store; this indirection keeps
 * the security modules free of a hard dependency on the Zustand store (which
 * would pull React/persistence into pure enforcement code and tests). The app
 * bootstrap registers a source via {@link setPluginSecurityPostureSource}.
 */

import type { PluginSecurityPosture } from "./network-allowlist"

export type { PluginSecurityPosture }

type PostureSource = () => PluginSecurityPosture | undefined

let postureSource: PostureSource | null = null
let testOverride: PluginSecurityPosture | null = null

/**
 * Register the live posture source (wired to the settings store at bootstrap).
 * Pass `null` to detach.
 */
export function setPluginSecurityPostureSource(source: PostureSource | null): void {
  postureSource = source
}

/** Resolve the active posture. Defaults to "balanced" (historical behaviour). */
export function getPluginSecurityPosture(): PluginSecurityPosture {
  return testOverride ?? postureSource?.() ?? "balanced"
}

/** Test-only hard override; pass `null` to clear. */
export function __setPluginSecurityPostureForTesting(posture: PluginSecurityPosture | null): void {
  testOverride = posture
}

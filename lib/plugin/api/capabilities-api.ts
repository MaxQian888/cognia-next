/**
 * Plugin Platform Capability API.
 *
 * Replaces the scatter of direct `isTauri()` / `isMobile()` checks across
 * plugins with a single `ctx.capabilities` namespace. Read once at plugin
 * activation; the result is stable for the lifetime of the host process
 * (no plugin can hot-migrate between Tauri and the browser shell).
 *
 * The flags are computed eagerly at context-creation time — `ctx.capabilities`
 * is a plain object, not a function, so it's safe to destructure.
 *
 * ADR-0026 §5 §C.
 */

import { detectNativePlatform } from "@/lib/capacitor/_shared"
import { isTauri } from "@/lib/native/utils"
import { getSecretsBackendKind } from "./secrets-api"
import type { PluginCapabilitiesAPI } from "@cognia/plugin-contract/lib/plugin/api/capabilities-api"
export type { PluginCapabilitiesAPI } from "@cognia/plugin-contract/lib/plugin/api/capabilities-api"

export function createCapabilitiesAPI(): PluginCapabilitiesAPI {
  const platform = detectNativePlatform()
  const tauri = isTauri()
  return {
    tauri,
    mobile: platform === "mobile",
    web: platform === "web" && !tauri,
    browser: typeof window !== "undefined",
    platform,
    secretsBackend: getSecretsBackendKind(),
  }
}

/** Test-only — force-build a capabilities object with explicit flags. */
export function __makeCapabilitiesForTesting(
  overrides: Partial<PluginCapabilitiesAPI> = {}
): PluginCapabilitiesAPI {
  const base = createCapabilitiesAPI()
  return { ...base, ...overrides }
}

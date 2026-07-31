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

import { detectNativePlatform, type NativePlatform } from "@/lib/capacitor/_shared"
import { isTauri } from "@/lib/native/utils"
import { getSecretsBackendKind } from "./secrets-api"
import type { PluginSecretsBackend } from "@/types/plugin/plugin"

export interface PluginCapabilitiesAPI {
  /** True when the host is the Tauri desktop shell. */
  tauri: boolean
  /** True when the host is the Capacitor mobile shell. */
  mobile: boolean
  /** True when the host is a regular web browser (no Tauri, no Capacitor). */
  web: boolean
  /** True whenever a DOM is reachable — false in SSR or worker contexts. */
  browser: boolean
  /**
   * Discriminated platform string, mirrors `NativePlatform` from
   * `lib/capacitor/_shared`. Useful for switch-based dispatch.
   */
  platform: NativePlatform
  /**
   * Where `ctx.secrets` stores values at rest: OS keyring (desktop),
   * AES-GCM-encrypted IndexedDB (browser/mobile), or in-memory only. A
   * security-sensitive plugin can refuse to run on a weaker backend.
   */
  secretsBackend: PluginSecretsBackend
}

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

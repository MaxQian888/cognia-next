/**
 * The plugin contract's share of `lib/plugin/api/capabilities-api.ts`, which re-exports these.
 */
import type { NativePlatform } from "../../capacitor/_shared"
import type { PluginSecretsBackend } from "../../../types/plugin/plugin"

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

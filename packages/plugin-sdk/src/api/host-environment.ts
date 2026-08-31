/**
 * Plugin SDK — portable host-environment helpers for code that cannot retain
 * an activated context (for example a message renderer).
 *
 * `ctx.capabilities` already answers the first question for code that HAS a
 * context. This module exists for the code that does not: a module-scope
 * constant, a tool executor invoked through the plugin-tool IPC round trip, a
 * helper imported before `activate(ctx)` ever runs. Without it the only
 * available answer was `@/lib/tauri`'s `isTauri()` — a host-private import —
 * which is exactly what several first-party plugins reached for.
 */

/**
 * A snapshot of the host shell: `tauri` / `mobile` / `web` / `browser` and the
 * discriminated `platform` string. Stable for the lifetime of the process.
 */
export { createPluginLogger, readHostCapabilities } from "../runtime/host-environment"
export type { PluginHostEnvironmentSnapshot, PluginHostPlatform } from "../runtime/host-environment"
export type { PluginCapabilitiesAPI } from "@/lib/plugin/api/capabilities-api"

/**
 * The running app's version. A plugin that gates a contribution on a host
 * feature, or that stamps a version into something it writes, needs the real
 * value rather than a manifest-declared guess.
 */
export { APP_VERSION } from "@/lib/app-version"

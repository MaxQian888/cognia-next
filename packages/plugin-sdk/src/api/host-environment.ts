/**
 * Plugin SDK — `host-environment` surface: which shell am I running in, and
 * where is the user working?
 *
 * `ctx.capabilities` already answers the first question for code that HAS a
 * context. This module exists for the code that does not: a module-scope
 * constant, a tool executor invoked through the plugin-tool IPC round trip, a
 * helper imported before `activate(ctx)` ever runs. Without it the only
 * available answer was `@/lib/tauri`'s `isTauri()` — a host-private import —
 * which is exactly what several first-party plugins reached for.
 *
 * `getActiveWorkspaceRoot()` is the second question. `ctx.fs` is sandboxed to
 * the plugin's own data directory, so a plugin that wants to read the user's
 * project must be TOLD where that project is; this is the same resolution the
 * declarative CLI-tool executor uses, so a plugin tool and a `cliTools` entry
 * agree on the cwd.
 */

/**
 * A snapshot of the host shell: `tauri` / `mobile` / `web` / `browser`, the
 * discriminated `platform` string, and where `ctx.secrets` stores values at
 * rest. Stable for the lifetime of the process — no plugin can hot-migrate
 * between shells — so it is safe to read once into a module constant.
 */
export { createCapabilitiesAPI as readHostCapabilities } from "@/lib/plugin/api/capabilities-api"
export type { PluginCapabilitiesAPI } from "@/lib/plugin/api/capabilities-api"

/** Absolute path of the folder the user has open, or `undefined` if none. */
export { getActiveWorkspaceRoot } from "@/lib/plugin/api/workspace-root"

/**
 * The running app's version. A plugin that gates a contribution on a host
 * feature, or that stamps a version into something it writes, needs the real
 * value rather than a manifest-declared guess.
 */
export { APP_VERSION } from "@/lib/app-version"

/**
 * Test seam. `setTransport()` replaces the Tauri IPC transport a plugin's
 * desktop paths call through, so a plugin test can exercise them under jsdom
 * without a real host. Production code must never call it — the host installs
 * the real transport at boot, and replacing it mid-session silently redirects
 * every `invoke` in the process.
 *
 * Exposed because the alternative was worse: plugin tests were importing
 * `@/lib/tauri` directly to get at it, which pins the test to a host-private
 * path a third-party plugin could never use.
 */
export { setTransport } from "@/lib/tauri"
export type { Transport } from "@/lib/tauri/transport-types"

/**
 * A logger for code that runs outside `activate(ctx)` — a React card in the
 * transcript, a module-scope helper, a tool executor dispatched over IPC.
 * `ctx.logger` is the one to use whenever a context is in hand; this produces
 * the same plugin-scoped child logger without one, so failures are attributed
 * to the plugin rather than to whichever host module it borrowed a logger from.
 */
export { createPluginSystemLogger as createPluginLogger } from "@/lib/plugin/core/logger"

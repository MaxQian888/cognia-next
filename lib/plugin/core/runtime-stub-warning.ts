/**
 * Stamp a "this runtime is not available here" marker on a plugin row.
 *
 * The loaders hand back an inert stub when the host cannot run a plugin's
 * runtime. Only the Python path recorded that, and only because it carried its
 * own private copy of this write. WASM and VS Code extensions degraded in
 * exactly the same way and recorded nothing at all: the row said "Enabled",
 * the plugin did nothing, and the only trace was a `logger.warn` in a console
 * nobody has open.
 *
 * The marker is read by `readPluginRuntimeWarnings` and rendered by
 * `PluginRuntimeWarnings`. Every code here needs a matching
 * `plugins.card.runtimeWarnings.<code>` message in both locales.
 */

import { loggers } from "@cognia/logging"

export const RUNTIME_STUB_WARNINGS = {
  python: "python-runtime-unavailable",
  wasm: "wasm-runtime-unavailable",
  vscode: "vscode-runtime-unavailable",
} as const

export type RuntimeStubWarning = (typeof RUNTIME_STUB_WARNINGS)[keyof typeof RUNTIME_STUB_WARNINGS]

/**
 * Best-effort and idempotent. Runs detached from the activate flow so a Dexie
 * hiccup never blocks plugin load, and never appends the same code twice.
 */
export async function persistRuntimeStubWarning(
  pluginId: string,
  warning: RuntimeStubWarning
): Promise<void> {
  try {
    const { getPlugin, updatePlugin } = await import("@/lib/db/plugins")
    const row = await getPlugin(pluginId)
    if (!row) return
    const existing = (
      (row.manifest as { _cogniaWarnings?: string[] })._cogniaWarnings ?? []
    ).slice()
    if (existing.includes(warning)) return
    existing.push(warning)
    await updatePlugin(pluginId, {
      manifest: { ...row.manifest, _cogniaWarnings: existing },
    })
  } catch (writeError) {
    loggers.plugin.debug("Skipped runtime warning write for stubbed plugin", {
      pluginId,
      warning,
      error: writeError instanceof Error ? writeError.message : String(writeError),
    })
  }
}

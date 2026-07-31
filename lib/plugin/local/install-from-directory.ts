/**
 * Renderer-side wrapper around the `plugin_install_from_directory` Tauri
 * command (declared in `src-tauri/src/cli_bridge/mod.rs`). Used by the
 * "Load unpacked" UI in the plugin DevTools — the user picks a directory
 * containing `plugin.json` and we hand the absolute path over to the
 * native side, which copies it under the plugin runtime root and
 * registers a snapshot.
 *
 * The native command emits the same `cli-bridge:plugin-installed` event
 * the loopback HTTP bridge emits when a `cognia plugin install` lands,
 * so the renderer's `use-cli-bridge-events` hook can refresh the live
 * plugin list without branching on which install path ran.
 *
 * Failures are surfaced via the central error bus so the user sees a
 * toast even when the caller is fire-and-forget (e.g. DnD drop).
 */

import { invoke } from "@tauri-apps/api/core"

import { dispatchPluginError } from "@/lib/plugin/error-bus"
import { isTauri } from "@/lib/tauri"
import { loggers } from "@cognia/logging"
import type { PluginManifest } from "@/types/plugin"

export interface InstallFromDirectoryReceipt {
  pluginId: string
  warnings: string[]
}

export interface InstallFromDirectoryOptions {
  /** Override the plugin display name fed to the error-bus dispatch on
   *  failure — useful when the caller already resolved the manifest. */
  pluginName?: string
}

/**
 * Install the plugin whose `plugin.json` lives at `<sourceDir>/plugin.json`.
 * Returns the receipt on success; on failure, throws *and* dispatches a
 * `plugin:error` event so the central toaster surfaces the failure.
 *
 * On web (and Capacitor mobile) this is a no-op — the bridge doesn't
 * exist there, and shelling out to a file picker isn't meaningful in a
 * static-export bundle. The caller should gate the UI with `isTauri()`.
 */
export async function installPluginFromDirectory(
  sourceDir: string,
  options: InstallFromDirectoryOptions = {}
): Promise<InstallFromDirectoryReceipt> {
  if (!isTauri()) {
    const message = "Local plugin install is only available in the desktop app."
    dispatchPluginError({
      pluginId: sourceDir,
      pluginName: options.pluginName,
      stage: "local-install",
      message,
      severity: "error",
      recoverable: false,
    })
    throw new Error(message)
  }
  try {
    const result = await invoke<{ pluginId: string; warnings: string[] }>(
      "plugin_install_from_directory",
      { sourceDir }
    )
    loggers.plugin.info(`[local-install] installed ${result.pluginId} from ${sourceDir}`)
    return {
      pluginId: result.pluginId,
      warnings: result.warnings ?? [],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    dispatchPluginError({
      pluginId: sourceDir,
      pluginName: options.pluginName,
      stage: "local-install",
      message,
      severity: "error",
      recoverable: true,
    })
    throw err instanceof Error ? err : new Error(message)
  }
}

/**
 * Read and parse `plugin.json` at `<source>/plugin.json` (or directly
 * from a `plugin.json` file path) without installing it. Backs the
 * "preview the manifest before approving install" step in the Load
 * unpacked dialog and the standalone manifest validator panel.
 *
 * Does NOT dispatch to the error bus — failures are part of the normal
 * validator flow and the caller renders them inline.
 */
export async function previewLocalManifest(sourcePath: string): Promise<PluginManifest> {
  if (!isTauri()) {
    throw new Error("Local manifest preview is only available in the desktop app.")
  }
  const parsed = await invoke<unknown>("preview_local_manifest", {
    sourceDir: sourcePath,
  })
  return parsed as PluginManifest
}

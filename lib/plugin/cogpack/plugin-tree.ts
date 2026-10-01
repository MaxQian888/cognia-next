/**
 * An installed plugin's files as data (ADR-0209): read for an embedded cogpack
 * member, written back when a cogpack is imported.
 *
 * Both directions run in the Rust host (`plugin_export_tree`,
 * `plugin_install_from_files`). Reading there applies the same rules the
 * directory installer does; writing there is the only option, because the
 * webview's file-system scope cannot reach a staging directory.
 */

import { invoke } from "@tauri-apps/api/core"

import { decodeBase64, encodeBase64 } from "@/lib/share/encoding"
import { dispatchPluginError } from "@/lib/plugin/error-bus"
import { recordInstallOrigin } from "@/lib/plugin/origin/install-origin"
import { isTauri } from "@/lib/tauri"
import type { CogpackProvenance } from "@/types/plugin/plugin-cogset"

import type { EmbeddedPluginFile } from "./package"

interface ExportedTreeResponse {
  pluginId: string
  files: Array<{ path: string; base64: string; size: number }>
  totalBytes: number
}

/** The files of an installed plugin, relative to its root. Desktop only. */
export async function readInstalledPluginTree(pluginId: string): Promise<EmbeddedPluginFile[]> {
  if (!isTauri()) throw new Error("Reading a plugin's files needs the desktop app")
  const tree = await invoke<ExportedTreeResponse>("plugin_export_tree", { pluginId })
  return tree.files.map((file) => ({ path: file.path, bytes: decodeBase64(file.base64) }))
}

export interface InstallEmbeddedPluginOptions {
  /** The member id the review showed; the host refuses a tree that is another plugin. */
  pluginId: string
  pluginName?: string
  version: string
  viaCogpack: CogpackProvenance
}

/**
 * Install a plugin a cogpack embeds. Resolves to the installed plugin id; the
 * row appears through the same discovery event a "Load unpacked" raises.
 */
export async function installEmbeddedPlugin(
  files: ReadonlyMap<string, Uint8Array>,
  options: InstallEmbeddedPluginOptions
): Promise<{ pluginId: string; warnings: string[] }> {
  if (!isTauri()) throw new Error("Installing an embedded plugin needs the desktop app")
  const payload = [...files.entries()].map(([path, bytes]) => ({
    path,
    base64: encodeBase64(bytes),
  }))
  try {
    const receipt = await invoke<{ pluginId: string; warnings?: string[] }>(
      "plugin_install_from_files",
      { pluginId: options.pluginId, files: payload }
    )
    await recordInstallOrigin({
      pluginId: receipt.pluginId,
      version: options.version,
      origin: { kind: "local", via: "cogpack-embedded" },
      viaCogpack: options.viaCogpack,
    })
    return { pluginId: receipt.pluginId, warnings: receipt.warnings ?? [] }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    dispatchPluginError({
      pluginId: options.pluginName ?? "cogpack",
      pluginName: options.pluginName,
      stage: "local-install",
      message,
      severity: "error",
      recoverable: true,
    })
    throw error instanceof Error ? error : new Error(message)
  }
}

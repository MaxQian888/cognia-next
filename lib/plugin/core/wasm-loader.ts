/**
 * WASM plugin loader (TS side).
 *
 * WASM plugins execute in `src-tauri/src/plugin_api/wasm/` under wasmtime.
 * This module is a thin IPC client: the heavy work (component compile,
 * capability gating, store lifetime, epoch interruption) all lives in Rust.
 * We expose just enough to integrate with `PluginLoader` so the host can
 * activate / deactivate / invoke WASM plugins symmetrically with `frontend`
 * and `python` types.
 */

import type { PluginDefinition, PluginManifest } from "@/types/plugin"
import { loggers } from "@/lib/logger"

const wasmLoaderLogger = loggers.plugin.child("wasm-loader")

export interface WasmInvokeArgs {
  pluginId: string
  manifestJson: string
  pluginPath: string
}

export interface WasmActivateResult {
  /** Names of guest exports the host detected on the loaded component. */
  exports: string[]
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

let cachedInvoke: InvokeFn | undefined

async function getInvoke(): Promise<InvokeFn> {
  if (cachedInvoke) return cachedInvoke
  const mod = await import("@tauri-apps/api/core")
  cachedInvoke = mod.invoke as InvokeFn
  return cachedInvoke
}

/**
 * True when the current runtime can host WASM plugins (Tauri webview only).
 * Browser-mode users see a "desktop required" stub instead.
 */
export function isWasmHostAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

/**
 * Build a `PluginDefinition` for a `type === "wasm"` manifest. The returned
 * `activate` / `deactivate` hooks delegate to Tauri commands; the host then
 * instantiates the component inside its capability-gated wasmtime store.
 *
 * Browser-mode (non-Tauri) returns a stub that warns at activate time, the
 * same pattern as `loadPythonModule` uses for Python-runtime-unavailable.
 */
export async function loadWasmDefinition(
  manifest: PluginManifest,
  pluginPath: string
): Promise<PluginDefinition> {
  if (!manifest.wasmMain) {
    throw new Error(`WASM plugin ${manifest.id} missing 'wasmMain' entry point`)
  }
  if (!manifest.wasm?.apiVersion) {
    throw new Error(`WASM plugin ${manifest.id} missing 'wasm.apiVersion'`)
  }

  if (!isWasmHostAvailable()) {
    return {
      manifest,
      activate: async (context) => {
        context.logger.warn(
          `WASM plugin ${manifest.id} requires the Tauri desktop runtime. Running in stub mode.`
        )
        return {}
      },
      deactivate: async () => {},
    }
  }

  const invoke = await getInvoke()
  const args: WasmInvokeArgs = {
    pluginId: manifest.id,
    manifestJson: JSON.stringify(manifest),
    pluginPath,
  }

  try {
    await invoke("plugin_wasm_load", { ...args })
  } catch (error) {
    throw new Error(
      `Failed to load WASM plugin ${manifest.id}: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  return {
    manifest,
    activate: async (context) => {
      context.logger.info(`Activating WASM plugin ${manifest.id}`)
      try {
        const result = await invoke<WasmActivateResult>("plugin_wasm_activate", {
          pluginId: manifest.id,
          configJson: JSON.stringify(context.config ?? {}),
        })
        context.logger.debug("WASM plugin activated", {
          pluginId: manifest.id,
          exports: result?.exports ?? [],
        })
      } catch (error) {
        wasmLoaderLogger.error("WASM activate failed", error, { pluginId: manifest.id })
        throw error
      }
      return {}
    },
    deactivate: async () => {
      try {
        await invoke("plugin_wasm_deactivate", { pluginId: manifest.id })
      } catch (error) {
        wasmLoaderLogger.warn("WASM deactivate failed", {
          pluginId: manifest.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}

/**
 * Invoke a guest export by name on a loaded WASM plugin. The payload is
 * passed as JSON; the host wraps it in a `list<u8>` for the WIT contract.
 */
export async function callWasmExport<T = unknown>(
  pluginId: string,
  exportName: string,
  payload: unknown
): Promise<T> {
  if (!isWasmHostAvailable()) {
    throw new Error("WASM host unavailable (browser mode)")
  }
  const invoke = await getInvoke()
  const result = await invoke<string>("plugin_wasm_call", {
    pluginId,
    exportName,
    payloadJson: JSON.stringify(payload ?? null),
  })
  if (typeof result === "string" && result.length > 0) {
    return JSON.parse(result) as T
  }
  return result as T
}

/**
 * Permanently remove a loaded WASM plugin from the host. Called by
 * `PluginManager.uninstall` after lifecycle cleanup.
 */
export async function unloadWasmPlugin(pluginId: string): Promise<void> {
  if (!isWasmHostAvailable()) return
  const invoke = await getInvoke()
  try {
    await invoke("plugin_wasm_unload", { pluginId })
  } catch (error) {
    wasmLoaderLogger.warn("WASM unload failed", {
      pluginId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

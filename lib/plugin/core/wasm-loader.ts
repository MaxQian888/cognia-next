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

import { isHeadlessHost, isTauri } from "@/lib/platform/detect"
import { loggers } from "@cognia/logging"
import type { PluginDefinition, PluginManifest, PluginTool } from "@/types/plugin"
import type { PluginNodeDef } from "@/types/plugin/plugin-workflow"

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

async function invokeWasmHost<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke<T>(command, args)
  }
  const { transport } = await import("@/lib/tauri/transport-instance")
  return transport.call<T>(command, args)
}

/**
 * True when the current runtime can reach a native WASM host. Desktop owns it
 * in-process; the headless brain reaches cognia-server over its service
 * transport. Browser/mobile clients do not execute plugin guests themselves.
 */
export function isWasmHostAvailable(): boolean {
  return isTauri() || isHeadlessHost()
}

/**
 * Build a `PluginDefinition` for a `type === "wasm"` manifest. The returned
 * `activate` / `deactivate` hooks delegate to Tauri commands; the host then
 * instantiates the component inside its capability-gated wasmtime store.
 *
 * Browser/mobile mode returns a stub that warns at activate time, the
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
          `WASM plugin ${manifest.id} requires a native Cognia host. Running in stub mode.`
        )
        return {}
      },
      deactivate: async () => {},
    }
  }

  const args: WasmInvokeArgs = {
    pluginId: manifest.id,
    manifestJson: JSON.stringify(manifest),
    pluginPath,
  }

  try {
    await invokeWasmHost("plugin_wasm_load", { ...args })
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
        const result = await invokeWasmHost<WasmActivateResult>("plugin_wasm_activate", {
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
        await invokeWasmHost("plugin_wasm_deactivate", { pluginId: manifest.id })
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
    throw new Error("WASM host unavailable in this runtime")
  }
  const result = await invokeWasmHost<string>("plugin_wasm_call", {
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
 * Project a WASM plugin's declared `manifest.tools` into runnable
 * `PluginTool`s. A WASM guest implements a single `tool-execute(tool-name,
 * args)` export that dispatches by name (the host's `extract_kind` reads the
 * `kind` field of the payload), so every declared tool routes through that one
 * export with its name carried in the payload. Without this projection a WASM
 * plugin's tools are declared in the manifest but never reachable by the agent
 * — `callWasmExport` had no production caller. Mirrors the Python tool bridge
 * in `loadPythonPlugin`, but the definitions are declarative (the WIT contract
 * has no tool-listing export) rather than enumerated from the runtime.
 */
export function buildWasmToolDefinitions(manifest: PluginManifest): PluginTool[] {
  const pluginId = manifest.id
  return (manifest.tools ?? []).map((toolDef) => ({
    name: `${pluginId}:${toolDef.name}`,
    pluginId,
    definition: {
      name: toolDef.name,
      description: toolDef.description,
      parametersSchema: toolDef.parametersSchema,
    },
    execute: async (args: Record<string, unknown>) =>
      callWasmExport(pluginId, "tool-execute", { kind: toolDef.name, ...args }),
  }))
}

/**
 * Project a WASM plugin's declared `manifest.workflows.nodes` into runnable
 * `PluginNodeDef`s. A WASM guest implements a single `workflow-node-execute(
 * node-kind, params)` export that dispatches by kind (the host's `extract_kind`
 * reads the payload `kind`), so every declared node routes through that one
 * export with its UNPREFIXED kind carried in the payload.
 *
 * Without this projection the Rust `workflow-node-execute` dispatch (and the
 * guest's implementation) is unreachable: the orchestrator's `getExecutor`
 * misses and `step-executor` throws `No executor registered for <kind>`. The
 * returned defs are registered through the same `ctx.workflow.registerNode`
 * machinery as frontend plugins (kind-prefixing, catalog entry, unregister on
 * deactivate), so no registration logic is duplicated here.
 */
export function buildWasmNodeDefs(manifest: PluginManifest): PluginNodeDef[] {
  const pluginId = manifest.id
  const nodes = manifest.workflows?.nodes ?? []
  return nodes.map((node) => ({
    kind: node.kind,
    typeVersion: node.typeVersion,
    category: node.category,
    label: node.label,
    description: node.description,
    iconName: node.iconName,
    keywords: node.keywords,
    paramsSchema: node.paramsSchema,
    defaultParams: node.defaultParams,
    desktopOnly: node.desktopOnly,
    retryable: node.retryable,
    timeoutMs: node.timeoutMs,
    // The guest dispatches by the UNPREFIXED manifest kind; the registry uses
    // the pluginId-prefixed kind (applied by registerNode). Pass the resolved
    // params + upstream outputs so the guest node has its inputs.
    execute: async (ctx) => {
      const output = await callWasmExport(pluginId, "workflow-node-execute", {
        kind: node.kind,
        params: ctx.params,
        upstream: ctx.upstream,
      })
      return { output }
    },
  }))
}

/**
 * Permanently remove a loaded WASM plugin from the host. Called by
 * `PluginManager.uninstall` after lifecycle cleanup.
 */
export async function unloadWasmPlugin(pluginId: string): Promise<void> {
  if (!isWasmHostAvailable()) return
  try {
    await invokeWasmHost("plugin_wasm_unload", { pluginId })
  } catch (error) {
    wasmLoaderLogger.warn("WASM unload failed", {
      pluginId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

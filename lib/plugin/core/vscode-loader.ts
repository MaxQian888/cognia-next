/**
 * VS Code extension loader (TS side).
 *
 * VS Code extensions execute in a Node.js sidecar (`sidecar/vscode-ext-host/`)
 * managed by Tauri. This module is a thin IPC client: the heavy work
 * (subprocess lifecycle, capability gating, JSON-RPC plumbing) lives in Rust
 * under `src-tauri/src/plugin_api/vscode/`. We expose just enough to
 * integrate with `PluginLoader` so the host can activate / deactivate /
 * invoke VS Code extensions symmetrically with `frontend`, `python`, and
 * `wasm` types.
 *
 * Mirrors `lib/plugin/core/wasm-loader.ts` line-for-line where applicable.
 *
 * Phase M0: the Rust commands are not yet implemented. In dev / test the
 * loader returns a stub `PluginDefinition` that logs and exits — same
 * pattern WASM uses for browser fallback. The full sidecar wiring lands
 * in later phases of the plan (~/.claude/plans/vscode-snug-squid.md).
 */

import { isTauri } from "@/lib/platform/detect"
import { loggers } from "@/lib/logging"
import type { PluginDefinition, PluginManifest } from "@/types/plugin"
import {
  configureRpcDispatcher,
  subscribeToVscodeEvents,
} from "@/lib/plugin/vscode-shim/rpc-dispatcher"
import { installVscodeRpcHandlers } from "@/lib/plugin/vscode-shim/setup-handlers"
import { configureLmHandler } from "@/lib/plugin/vscode-shim/lm-handler"

const vscodeLoaderLogger = loggers.plugin.child("vscode-loader")

let dispatcherConfigured = false

/**
 * One-time wiring of the renderer-side RPC dispatcher to its Tauri
 * transport. Re-entrant: subsequent calls no-op. Called at the top of
 * `loadVscodeDefinition` so plain `import("..vscode-loader")` doesn't
 * trigger the Tauri shim outside of the desktop runtime.
 */
export async function ensureDispatcherConfigured(): Promise<void> {
  if (dispatcherConfigured) return
  if (!isVscodeHostAvailable()) return
  const [{ invoke }, { listen }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
  ])
  configureRpcDispatcher({
    sendResponse: async (pluginId, responseJson) => {
      await invoke("plugin_vscode_send_response", {
        pluginId,
        responseJson,
      })
    },
    listen: (event, cb) =>
      listen<string>(event, (e) => cb({ payload: e.payload })) as Promise<() => void>,
  })
  // Resolve cognia's currently configured Claude model for lm.selectChatModels.
  configureLmHandler({
    resolveDefaultModel: async () => {
      try {
        const settings = await invoke<{ model?: string } | null>("read_claude_user_settings")
        return settings?.model
      } catch {
        return undefined
      }
    },
  })
  installVscodeRpcHandlers()

  // Wire the monaco-bridge to the real Monaco API + the renderer→sidecar
  // request channel. Lazy-imported so non-Tauri code paths never pull
  // monaco-editor (the asset bundle is ~3 MB).
  try {
    const monaco = await import("monaco-editor")
    const { configureMonacoBridge } = await import("@/lib/plugin/vscode-shim/monaco-bridge")
    configureMonacoBridge({
      // The bridge's `MonacoApi` interface is structurally compatible with
      // monaco's `languages` and `editor` namespaces; casting through
      // `unknown` short-circuits the deep generic instantiation TS would
      // otherwise insist on.
      monacoApi: {
        languages: monaco.languages as never,
        editor: {
          setModelMarkers: (model, owner, markers) =>
            monaco.editor.setModelMarkers(
              model as unknown as Parameters<typeof monaco.editor.setModelMarkers>[0],
              owner,
              markers as unknown as Parameters<typeof monaco.editor.setModelMarkers>[2]
            ),
        },
      },
      dispatchRpc: (pluginId, method, payload) => invokeVscodeRpc(pluginId, method, payload),
    })

    // Consume `contributes.languages[]` (populated by the manager via
    // languages-bridge): register each contributed language id into Monaco and
    // keep it in sync as VS Code extensions enable / disable.
    const { installContributedLanguageSync } =
      await import("@/lib/plugin/vscode-shim/contributed-languages-monaco")
    installContributedLanguageSync({
      register: (language) => monaco.languages.register(language),
      setLanguageConfiguration: (languageId, configuration) =>
        monaco.languages.setLanguageConfiguration(
          languageId,
          configuration as Parameters<typeof monaco.languages.setLanguageConfiguration>[1]
        ),
    })
  } catch (error) {
    vscodeLoaderLogger.warn(
      "configureMonacoBridge skipped — monaco-editor failed to load; LSP providers will be dormant",
      { error: error instanceof Error ? error.message : String(error) }
    )
  }

  // Phase B — wire the standalone-LSP registry + Tauri adapter so
  // user-managed and plugin-contributed LSPs route through the sidecar.
  // Guarded by try/catch so a missing settings store (extremely early
  // boot) never blocks the VS Code extension activation path.
  try {
    // Migrate legacy developer.userLspServers / unsignedLspAllowed →
    // settings.lsp BEFORE the registry bootstraps so the editor resolves
    // from the unified field.
    const { initLspSettingsMigration } = await import("@/lib/lsp/migrate-settings-initializer")
    initLspSettingsMigration()
    const { bootstrapLspRegistry } = await import("@/lib/plugin/lsp/lsp-bootstrap")
    bootstrapLspRegistry()
  } catch (error) {
    vscodeLoaderLogger.warn(
      "bootstrapLspRegistry skipped — standalone LSP registry not configured",
      { error: error instanceof Error ? error.message : String(error) }
    )
  }

  dispatcherConfigured = true
}

export interface VscodeInvokeArgs {
  pluginId: string
  manifestJson: string
  pluginPath: string
}

export interface VscodeActivateResult {
  /** Names of commands the extension registered during activate(). */
  registeredCommands: string[]
  /** Names of webview view providers the extension registered. */
  registeredWebviewViews: string[]
  /** Names of language providers (completion / hover / formatting / …). */
  registeredLanguageProviders: string[]
  /** Sidecar PID for the runtime telemetry table. */
  sidecarPid: number
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
 * True when the current runtime can host VS Code extensions (Tauri webview
 * only). Browser-mode users see a "desktop required" stub instead.
 */
export function isVscodeHostAvailable(): boolean {
  return isTauri()
}

/**
 * Build a `PluginDefinition` for a `type === "vscode-extension"` manifest.
 * The returned `activate` / `deactivate` hooks delegate to Tauri commands;
 * the Rust host then spawns / signals the Node sidecar.
 *
 * Browser-mode (non-Tauri) returns a stub that warns at activate time, the
 * same pattern as `loadWasmDefinition` and `loadPythonModule` use.
 */
export async function loadVscodeDefinition(
  manifest: PluginManifest,
  pluginPath: string
): Promise<PluginDefinition> {
  if (!manifest.vscodeMain && !hasThemeOnlyContributions(manifest)) {
    throw new Error(
      `VS Code extension ${manifest.id} has no 'vscodeMain' entry point and no theme-only contributions`
    )
  }
  if (!manifest.vscodeExtension?.identifier) {
    throw new Error(
      `VS Code extension ${manifest.id} is missing the vscodeExtension.identifier block — manifest adapter must populate this at install`
    )
  }

  if (!isVscodeHostAvailable()) {
    return {
      manifest,
      activate: async (context) => {
        context.logger.warn(
          `VS Code extension ${manifest.id} requires the Tauri desktop runtime. Running in stub mode.`
        )
        return {}
      },
      deactivate: async () => {},
    }
  }

  // Theme-only extensions never need the Node sidecar — themes register
  // through the existing themes-bridge at enable time. We still return a
  // PluginDefinition so the plugin manager treats the package uniformly.
  if (!manifest.vscodeMain) {
    return {
      manifest,
      activate: async (context) => {
        context.logger.info(
          `VS Code theme-only extension ${manifest.id} activated (sidecar not needed)`
        )
        return {}
      },
      deactivate: async () => {},
    }
  }

  const invoke = await getInvoke()
  await ensureDispatcherConfigured()
  const args: VscodeInvokeArgs = {
    pluginId: manifest.id,
    manifestJson: JSON.stringify(manifest),
    pluginPath,
  }

  try {
    await invoke("plugin_load_vscode", { ...args })
  } catch (error) {
    throw new Error(
      `Failed to load VS Code extension ${manifest.id}: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  let unsubscribe: (() => void) | undefined
  try {
    unsubscribe = await subscribeToVscodeEvents(manifest.id)
  } catch (error) {
    vscodeLoaderLogger.warn("subscribe failed; sidecar→renderer notifications will not arrive", {
      pluginId: manifest.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return {
    manifest,
    activate: async (context) => {
      context.logger.info(`Activating VS Code extension ${manifest.id}`)
      try {
        const result = await invoke<VscodeActivateResult>("plugin_activate_vscode", {
          pluginId: manifest.id,
          configJson: JSON.stringify(context.config ?? {}),
        })
        context.logger.debug("VS Code extension activated", {
          pluginId: manifest.id,
          registeredCommands: result?.registeredCommands ?? [],
          registeredWebviewViews: result?.registeredWebviewViews ?? [],
          registeredLanguageProviders: result?.registeredLanguageProviders ?? [],
          sidecarPid: result?.sidecarPid,
        })
      } catch (error) {
        vscodeLoaderLogger.error("VS Code activate failed", error, {
          pluginId: manifest.id,
        })
        throw error
      }
      return {}
    },
    deactivate: async () => {
      try {
        await invoke("plugin_deactivate_vscode", { pluginId: manifest.id })
      } catch (error) {
        vscodeLoaderLogger.warn("VS Code deactivate failed", {
          pluginId: manifest.id,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        try {
          unsubscribe?.()
        } catch (error) {
          vscodeLoaderLogger.warn("VS Code event unsubscribe failed", {
            pluginId: manifest.id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    },
  }
}

/**
 * Invoke a sidecar RPC by name on a loaded VS Code extension. Used by the
 * vscode-shim to proxy `vscode.*` calls back into the renderer's `ctx.*`
 * surface (and vice versa).
 */
export async function invokeVscodeRpc<T = unknown>(
  pluginId: string,
  method: string,
  payload: unknown
): Promise<T> {
  if (!isVscodeHostAvailable()) {
    throw new Error("VS Code extension host unavailable (browser mode)")
  }
  const invoke = await getInvoke()
  const result = await invoke<string>("plugin_invoke_vscode_rpc", {
    pluginId,
    method,
    payloadJson: JSON.stringify(payload ?? null),
  })
  if (typeof result === "string" && result.length > 0) {
    return JSON.parse(result) as T
  }
  return result as T
}

/**
 * Permanently remove a loaded VS Code extension from the host. Called by
 * `PluginManager.uninstall` after lifecycle cleanup. Idempotent.
 */
export async function unloadVscodeExtension(pluginId: string): Promise<void> {
  if (!isVscodeHostAvailable()) return
  const invoke = await getInvoke()
  try {
    await invoke("plugin_unload_vscode", { pluginId })
  } catch (error) {
    vscodeLoaderLogger.warn("VS Code unload failed", {
      pluginId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Whether the manifest contributes only themes / grammars / iconThemes —
 * those run in the renderer through the existing bridges and don't need
 * the Node sidecar.
 */
function hasThemeOnlyContributions(manifest: PluginManifest): boolean {
  // W5.1: grammar-only / icon-theme-only / snippet-only extensions are as
  // legitimate as theme-only ones — none of them need a `vscodeMain` bundle.
  return (
    (manifest.themes ?? []).length > 0 ||
    (manifest.vscodeGrammars ?? []).length > 0 ||
    (manifest.vscodeIconThemes ?? []).length > 0 ||
    (manifest.vscodeSnippets ?? []).length > 0 ||
    (manifest.vscodeLanguages ?? []).length > 0
  )
}

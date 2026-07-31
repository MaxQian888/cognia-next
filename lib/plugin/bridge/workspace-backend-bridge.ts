/**
 * Workspace Backend Bridge.
 *
 * Resolves `manifest.workspaceBackends` contributions on plugin enable.
 * Mirrors `ocr-providers-bridge.ts` in shape: lazy-factory dynamic import
 * → registration through the namespaced plugin API → auto-cleanup on
 * disable.
 *
 * See ADR-0026 §2 §D.
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type {
  PluginWorkspaceBackendDef,
  PluginWorkspaceBackendFactory,
  WorkspaceProvider,
} from "@/types/plugin/plugin-workspace-backend"
import { loggers } from "@/lib/plugin/core/logger"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import {
  clearWorkspaceBackendsForPluginContext,
  createWorkspaceAPI,
} from "@/lib/plugin/api/workspace-api"
import {
  createPythonBackedProxy,
  isPythonBackedContribution,
} from "@/lib/plugin/bridge/_shared/python-backed-proxy"

export interface WorkspaceBackendBridgeError {
  pluginId: string
  backendId: string
  message: string
}

export interface WorkspaceBackendBridgeResult {
  registered: number
  errors: WorkspaceBackendBridgeError[]
}

export interface WorkspaceBackendBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
  getConfig?: (pluginId: string, key: string) => unknown
  getSecret?: (pluginId: string, key: string) => Promise<string | undefined>
}

const DEFAULT_IMPORTER: NonNullable<WorkspaceBackendBridgeOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

export async function registerWorkspaceBackendsForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: WorkspaceBackendBridgeOptions = {}
): Promise<WorkspaceBackendBridgeResult> {
  const pluginId = manifest.id
  const defs = manifest.workspaceBackends ?? []
  if (defs.length === 0) {
    return { registered: 0, errors: [] }
  }

  clearWorkspaceBackendsForPluginContext(pluginId)

  const importer = options.importer ?? DEFAULT_IMPORTER
  const api = createWorkspaceAPI(pluginId)
  const errors: WorkspaceBackendBridgeError[] = []
  let registered = 0

  for (const def of defs) {
    try {
      const backend = await resolveBackend(
        def,
        pluginId,
        manifest.type,
        installRoot,
        importer,
        options
      )
      api.registerBackend({
        id: def.id,
        label: def.label,
        description: def.description,
        backend,
      })
      registered++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ pluginId, backendId: def.id, message })
      loggers.manager.error(`[workspace-bridge] failed to register ${pluginId}:${def.id}`, err)
    }
  }

  return { registered, errors }
}

const WORKSPACE_BACKEND_METHODS = ["clone", "commitAndPush", "remove"] as const

async function resolveBackend(
  def: PluginWorkspaceBackendDef,
  pluginId: string,
  pluginType: string | undefined,
  installRoot: string,
  importer: NonNullable<WorkspaceBackendBridgeOptions["importer"]>,
  options: WorkspaceBackendBridgeOptions
): Promise<WorkspaceProvider> {
  // Python-backed backends need no descriptor round-trip: id/label/description
  // come from the manifest def, so the provider is pure behaviour.
  if (isPythonBackedContribution(def, pluginType)) {
    return createPythonBackedProxy<WorkspaceProvider>({
      pluginId,
      contributionId: def.id,
      methods: [...WORKSPACE_BACKEND_METHODS],
      label: "workspace backend",
    })
  }

  if (!def.entry || !def.export) {
    throw new Error(
      `JS-backed workspace backend "${def.id}" must declare both "entry" and "export"` +
        ` (set backend: "python" to run it in the plugin's Python subprocess)`
    )
  }

  const resolved = resolvePluginPath(installRoot, def.entry)
  const mod = await importer(resolved)
  const exported = mod[def.export]
  if (typeof exported !== "function") {
    throw new Error(
      `entry "${def.entry}" does not export a factory named "${def.export}" (got ${typeof exported})`
    )
  }
  const factory = exported as PluginWorkspaceBackendFactory
  const ctx = {
    backendId: `${pluginId}:${def.id}`,
    pluginId,
    getConfig: <T = unknown>(key: string) => options.getConfig?.(pluginId, key) as T | undefined,
    getSecret: (key: string) => Promise.resolve(options.getSecret?.(pluginId, key) ?? undefined),
  }
  const backend = await factory(ctx)
  if (
    !backend ||
    typeof backend.clone !== "function" ||
    typeof backend.commitAndPush !== "function" ||
    typeof backend.remove !== "function"
  ) {
    throw new Error(`factory "${def.export}" returned an invalid WorkspaceProvider`)
  }
  return backend
}

export function unregisterWorkspaceBackendsForPlugin(pluginId: string): void {
  clearWorkspaceBackendsForPluginContext(pluginId)
}

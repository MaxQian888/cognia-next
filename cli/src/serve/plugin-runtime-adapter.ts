/** Node adapter for the headless PluginManager lifecycle. */

import type { HeadlessPluginRuntimeAdapter } from "@/lib/headless/types"
import type { PluginManifest } from "@/types/plugin"

import { defaultDiscoverDiskPlugins, type DiskPluginEntry } from "../plugin/host"
import {
  ensurePluginRuntime,
  pluginDiscoveryRoots,
  type PluginRuntimeResult,
} from "../plugin/plugin-runtime"

interface PluginManagerLifecycle {
  registerDiskPlugin(manifest: PluginManifest, dir: string): Promise<void>
  loadPlugin(id: string): Promise<void>
  enablePlugin(id: string): Promise<void>
  unloadPlugin(id: string): Promise<void>
}

interface PluginStoreLifecycle {
  plugins: Record<string, { status: string }>
  uninstallPlugin(
    id: string,
    options: { skipFileRemoval: boolean; viaManager: boolean }
  ): Promise<void>
}

function isRunnableInNodeBrain(entry: DiskPluginEntry): boolean {
  return (
    entry.supported ||
    entry.manifest.type === "wasm" ||
    entry.manifest.type === "python" ||
    entry.manifest.type === "hybrid" ||
    entry.manifest.type === "vscode-extension"
  )
}

export interface NodePluginRuntimeDeps {
  ensure?: () => Promise<PluginRuntimeResult>
  discover?: () => Promise<DiskPluginEntry[]>
  manager?: () => Promise<PluginManagerLifecycle>
  store?: () => Promise<PluginStoreLifecycle>
  dispose?: () => Promise<void> | void
}

async function defaultManager(): Promise<PluginManagerLifecycle> {
  const { getPluginManager } = await import("@/lib/plugin/core/manager")
  return getPluginManager()
}

async function defaultStore(): Promise<PluginStoreLifecycle> {
  const { usePluginStore } = await import("@/stores/plugin-runtime")
  return usePluginStore.getState() as PluginStoreLifecycle
}

async function defaultDispose(): Promise<void> {
  const { disposePluginManager } = await import("@/lib/plugin/core/manager")
  disposePluginManager()
}

/**
 * Bind cognia-server's native disk lifecycle to the already-canonical Node
 * PluginManager. Installs/restores refresh and activate the changed manifest;
 * uninstalls unload contributions before removing the store projection.
 */
export function createNodePluginRuntimeAdapter(
  deps: NodePluginRuntimeDeps = {}
): HeadlessPluginRuntimeAdapter {
  const getManager = deps.manager ?? defaultManager
  const getStore = deps.store ?? defaultStore
  const dispose = deps.dispose ?? defaultDispose
  const discover =
    deps.discover ?? (() => defaultDiscoverDiskPlugins(pluginDiscoveryRoots(process.env)))

  const reconcile = async (change: Parameters<HeadlessPluginRuntimeAdapter["reconcile"]>[0]) => {
    const manager = await getManager()
    const store = await getStore()
    const existing = store.plugins[change.pluginId]

    if (change.action === "uninstalled") {
      if (!existing) return
      await manager.unloadPlugin(change.pluginId)
      await store.uninstallPlugin(change.pluginId, {
        skipFileRemoval: true,
        viaManager: false,
      })
      return
    }

    const entry = (await discover()).find((candidate) => candidate.id === change.pluginId)
    if (!entry) {
      throw new Error(`Installed plugin manifest is missing: ${change.pluginId}`)
    }
    if (!isRunnableInNodeBrain(entry)) {
      throw new Error(
        `Plugin type "${entry.manifest.type}" is unavailable in the Node brain: ${change.pluginId}`
      )
    }

    if (existing && existing.status !== "installed") {
      await manager.unloadPlugin(change.pluginId)
    }
    await manager.registerDiskPlugin(entry.manifest, entry.dir)
    await manager.loadPlugin(change.pluginId)
    await manager.enablePlugin(change.pluginId)
  }

  return {
    async start() {
      const result = await (deps.ensure ?? ensurePluginRuntime)()
      if (!result.ok) {
        throw new Error(result.error || "PluginManager bootstrap failed")
      }
      // The shared CLI bootstrap already registers frontend entries. Native
      // entries were intentionally skipped by its standalone-CLI filter. In
      // the supervised brain the service transport provides their real
      // WASM/Python hosts, so project and activate them now. Hybrid is included
      // because both halves transition through one PluginManager lifecycle.
      for (const entry of await discover()) {
        if (
          entry.manifest.type === "wasm" ||
          entry.manifest.type === "python" ||
          entry.manifest.type === "hybrid" ||
          entry.manifest.type === "vscode-extension"
        ) {
          await reconcile({ action: "installed", pluginId: entry.id })
        }
      }
    },

    reconcile,

    async stop() {
      const manager = await getManager()
      const store = await getStore()
      const activeIds = Object.entries(store.plugins)
        .filter(([, plugin]) => plugin.status !== "installed")
        .map(([id]) => id)
        .reverse()
      try {
        for (const id of activeIds) {
          await manager.unloadPlugin(id)
        }
      } finally {
        await dispose()
      }
    },
  }
}

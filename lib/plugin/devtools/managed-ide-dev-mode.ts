import type { CodeServerProxyArtifact } from "@/lib/codeserver/client"
import {
  clearManagedIdeRpcTraces,
  getManagedIdeRpcTraces,
  setManagedIdePermissionSimulator,
  type ManagedIdeRpcTrace,
} from "@/lib/plugin/ide/broker-runtime"
import { IdeManifestError, normalizeIdeManifest } from "@/lib/plugin/ide/manifest"
import { prepareManagedIdeProxy } from "@/lib/plugin/ide/proxy-manager"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import type { Plugin, PluginPermission } from "@/types/plugin"

import { getPluginHotReload, type PluginHotReload } from "./hot-reload"

export interface ManagedIdeManifestDiagnostic {
  severity: "error" | "warning"
  code: string
  message: string
  field?: string
}

export interface ManagedIdeDevModeDependencies {
  isEnabled(): boolean
  getPlugin(pluginId: string): Plugin | undefined
  prepareProxy(plugin: Plugin): Promise<CodeServerProxyArtifact | null>
  hotReload: Pick<PluginHotReload, "setConfig" | "startWatching" | "stopWatching" | "onReload">
}

/**
 * Public managed-IDE development surface. It composes the existing plugin file
 * watcher with deterministic proxy generation; plugin business logic is still
 * reloaded in Cognia and never copied into the generated VSIX.
 */
export class ManagedIdeDevMode {
  private removeReloadListener: (() => void) | null = null
  private listeners = new Set<
    (event: {
      pluginId: string
      diagnostics: ManagedIdeManifestDiagnostic[]
      artifact?: CodeServerProxyArtifact | null
    }) => void
  >()

  constructor(
    private readonly dependencies: ManagedIdeDevModeDependencies = defaultDependencies()
  ) {}

  validate(plugin: Plugin): ManagedIdeManifestDiagnostic[] {
    try {
      const result = normalizeIdeManifest(plugin.manifest.id, plugin.manifest)
      return result.warnings.map((message) => ({
        severity: "warning",
        code: message,
        message,
      }))
    } catch (error) {
      if (error instanceof IdeManifestError) {
        return [
          {
            severity: "error",
            code: error.code,
            message: error.message,
            field: error.field,
          },
        ]
      }
      return [
        {
          severity: "error",
          code: "IDE_DEV_MANIFEST_INVALID",
          message: error instanceof Error ? error.message : String(error),
        },
      ]
    }
  }

  async rebuild(plugin: Plugin): Promise<CodeServerProxyArtifact | null> {
    this.assertEnabled()
    this.assertDevelopmentPlugin(plugin)
    const diagnostics = this.validate(plugin)
    const failure = diagnostics.find((entry) => entry.severity === "error")
    if (failure) throw new Error(failure.message)
    return this.dependencies.prepareProxy(plugin)
  }

  async startWatching(plugins: Plugin[]): Promise<void> {
    this.assertEnabled()
    const managed = plugins.filter(
      (plugin) =>
        (plugin.source === "dev" || plugin.source === "local") &&
        plugin.manifest.ide?.targets.includes("pro-ide")
    )
    await this.stopWatching()
    this.dependencies.hotReload.setConfig({
      enabled: true,
      autoReload: true,
      preserveState: true,
    })
    this.removeReloadListener = this.dependencies.hotReload.onReload((result) => {
      const plugin = this.dependencies.getPlugin(result.pluginId)
      if (!plugin) return
      void this.rebuild(plugin)
        .then((artifact) => {
          this.emit({ pluginId: result.pluginId, diagnostics: this.validate(plugin), artifact })
        })
        .catch((error) => {
          this.emit({
            pluginId: result.pluginId,
            diagnostics: [
              {
                severity: "error",
                code: "IDE_DEV_PROXY_REBUILD_FAILED",
                message: error instanceof Error ? error.message : String(error),
              },
            ],
          })
        })
    })
    await this.dependencies.hotReload.startWatching(managed)
  }

  async stopWatching(): Promise<void> {
    this.removeReloadListener?.()
    this.removeReloadListener = null
    await this.dependencies.hotReload.stopWatching()
  }

  inspectRpc(): ManagedIdeRpcTrace[] {
    this.assertEnabled()
    return getManagedIdeRpcTraces()
  }

  clearRpc(): void {
    this.assertEnabled()
    clearManagedIdeRpcTraces()
  }

  simulatePermissions(
    simulator: (input: {
      pluginId: string
      permission: PluginPermission
      reason: string
    }) => boolean | undefined
  ): () => void {
    this.assertEnabled()
    setManagedIdePermissionSimulator(simulator)
    return () => setManagedIdePermissionSimulator(undefined)
  }

  onDidRebuild(
    listener: (event: {
      pluginId: string
      diagnostics: ManagedIdeManifestDiagnostic[]
      artifact?: CodeServerProxyArtifact | null
    }) => void
  ): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: {
    pluginId: string
    diagnostics: ManagedIdeManifestDiagnostic[]
    artifact?: CodeServerProxyArtifact | null
  }): void {
    for (const listener of this.listeners) listener(event)
  }

  private assertEnabled(): void {
    if (!this.dependencies.isEnabled()) throw new Error("IDE_DEV_MODE_DISABLED")
  }

  private assertDevelopmentPlugin(plugin: Plugin): void {
    if (plugin.source !== "dev" && plugin.source !== "local") {
      throw new Error("IDE_DEV_MODE_PLUGIN_SOURCE_REQUIRED")
    }
  }
}

function defaultDependencies(): ManagedIdeDevModeDependencies {
  return {
    isEnabled: () =>
      process.env.NODE_ENV !== "production" &&
      usePluginStore.getState().pluginSettings.developerModeEnabled,
    getPlugin: (pluginId) => usePluginStore.getState().plugins[pluginId],
    prepareProxy: prepareManagedIdeProxy,
    hotReload: getPluginHotReload(),
  }
}

import type { ComponentType } from "react"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { resolveContextPanelIcon } from "@/lib/context-workbench/panel-icons"
import { recordPluginPointDiagnostic } from "@/lib/plugin/contracts/diagnostics-store"
import { loggers } from "@/lib/plugin/core/logger"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import {
  CONTEXT_RESOURCE_READ_PERMISSIONS,
  type ContextPanelDefinition,
  type ContextPanelRenderProps,
} from "@/types/context-workbench"
import type { PluginManifest } from "@/types/plugin/plugin"

export interface ContextPanelBridgeError {
  pluginId: string
  panelId: string
  message: string
}

export interface ContextPanelBridgeResult {
  registered: number
  errors: ContextPanelBridgeError[]
}

export interface ContextPanelBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
  hasPermission: (permission: string) => boolean
}

const DEFAULT_IMPORTER: NonNullable<ContextPanelBridgeOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

function requiredPermissions(manifest: PluginManifest, index: number): string[] {
  const panel = manifest.contextPanels?.[index]
  if (!panel) return []
  return [
    "extension:ui",
    ...panel.resourceKinds.map((kind) => CONTEXT_RESOURCE_READ_PERMISSIONS[kind]),
  ].filter(
    (permission, permissionIndex, permissions) =>
      permissions.indexOf(permission) === permissionIndex
  )
}

export async function registerContextPanelsForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: ContextPanelBridgeOptions
): Promise<ContextPanelBridgeResult> {
  const defs = manifest.contextPanels ?? []
  if (defs.length === 0) return { registered: 0, errors: [] }

  contextPanelRegistry.unregisterPlugin(manifest.id)
  const importer = options.importer ?? DEFAULT_IMPORTER
  const errors: ContextPanelBridgeError[] = []
  let registered = 0

  for (const [index, def] of defs.entries()) {
    try {
      const denied = requiredPermissions(manifest, index).find(
        (permission) => !options.hasPermission(permission)
      )
      if (denied) throw new Error(`Permission denied: ${denied} is required`)

      const entry = resolvePluginPath(installRoot, def.entry)
      const importedModule = await importer(entry)
      const exported = importedModule[def.export]
      if (typeof exported !== "function") {
        throw new Error(`entry "${def.entry}" has no React export named "${def.export}"`)
      }
      // A named export that is declared but missing is a manifest bug, not a
      // reason to drop the whole panel — but it must not be swallowed either,
      // or the author sees a panel that silently never fires its hook.
      const optionalExport = (name: string | undefined, field: string) => {
        if (!name) return undefined
        const value = importedModule[name]
        if (typeof value !== "function") {
          throw new Error(`entry "${def.entry}" has no "${field}" export named "${name}"`)
        }
        return value
      }
      const onFirstActivate = optionalExport(def.onFirstActivateExport, "onFirstActivate") as
        ContextPanelDefinition["onFirstActivate"] | undefined
      const onRestore = optionalExport(def.onRestoreExport, "onRestore") as
        ContextPanelDefinition["onRestore"] | undefined
      const getBadge = optionalExport(def.getBadgeExport, "getBadge") as
        ContextPanelDefinition["getBadge"] | undefined
      const permissions = requiredPermissions(manifest, index)
      contextPanelRegistry.register({
        id: `${manifest.id}:${def.id}`,
        activity: def.activity,
        labelKey: def.labelKey,
        label: def.label,
        icon: resolveContextPanelIcon(def.icon),
        order: def.order,
        appliesTo: (resource) => def.resourceKinds.includes(resource.kind),
        requiredCapabilities: def.requiredCapabilities,
        // Declared for diagnostics; the gate is the closure below, which is the
        // only form that can see *this* plugin's grants.
        requiredPermissions: permissions,
        hasRequiredPermissions: () =>
          permissions.every((permission) => options.hasPermission(permission)),
        getBadge,
        requiresChatScope: def.requiresChatScope,
        preferredMode: def.preferredMode,
        retention: def.retention ?? "stateful",
        renderer: exported as ComponentType<ContextPanelRenderProps>,
        onFirstActivate,
        onRestore,
        pluginId: manifest.id,
      })
      registered += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push({ pluginId: manifest.id, panelId: def.id, message })
      recordPluginPointDiagnostic(manifest.id, {
        code: "plugin.silent-failure",
        severity: "error",
        pointKind: "runtime",
        pointId: `context-panel:${def.id}`,
        message: `Context panel "${def.id}" was not registered: ${message}`,
        hint: "Check the panel declaration, export, and resource permissions.",
      })
      loggers.manager.error(
        `[context-panels-bridge] failed to register ${manifest.id} panel "${def.id}"`,
        error
      )
    }
  }

  return { registered, errors }
}

export function unregisterContextPanelsForPlugin(pluginId: string): void {
  contextPanelRegistry.unregisterPlugin(pluginId)
}

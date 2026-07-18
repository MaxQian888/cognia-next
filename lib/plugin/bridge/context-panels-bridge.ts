import type { ComponentType } from "react"
import {
  BlocksIcon,
  BotIcon,
  FileTextIcon,
  HistoryIcon,
  InfoIcon,
  MessageSquareIcon,
  PanelRightIcon,
  PlayIcon,
  SearchCodeIcon,
  SettingsIcon,
  WrenchIcon,
} from "lucide-react"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { CONTEXT_RESOURCE_READ_PERMISSIONS } from "@/lib/plugin/api/context-panel-api"
import { recordPluginPointDiagnostic } from "@/lib/plugin/contracts/diagnostics-store"
import { loggers } from "@/lib/plugin/core/logger"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import type { ContextPanelRenderProps } from "@/types/context-workbench"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginContextPanelIcon } from "@/types/plugin/plugin-context-panel"

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

const SAFE_ICONS: Record<PluginContextPanelIcon, ComponentType<{ className?: string }>> = {
  blocks: BlocksIcon,
  bot: BotIcon,
  "file-text": FileTextIcon,
  history: HistoryIcon,
  info: InfoIcon,
  "message-square": MessageSquareIcon,
  "panel-right": PanelRightIcon,
  play: PlayIcon,
  "search-code": SearchCodeIcon,
  settings: SettingsIcon,
  wrench: WrenchIcon,
}

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
      const permissions = requiredPermissions(manifest, index)
      contextPanelRegistry.register({
        id: `${manifest.id}:${def.id}`,
        activity: def.activity,
        labelKey: def.labelKey,
        label: def.label,
        icon: def.icon ? SAFE_ICONS[def.icon] : undefined,
        order: def.order,
        appliesTo: (resource) => def.resourceKinds.includes(resource.kind),
        requiredCapabilities: def.requiredCapabilities,
        hasRequiredPermissions: () =>
          permissions.every((permission) => options.hasPermission(permission)),
        preferredMode: def.preferredMode,
        retention: def.retention ?? "stateful",
        renderer: exported as ComponentType<ContextPanelRenderProps>,
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

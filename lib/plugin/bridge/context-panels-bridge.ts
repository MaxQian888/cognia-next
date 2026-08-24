import type { ComponentType } from "react"
import { createContextPanelWebviewRenderer } from "@/components/plugins/plugin-context-panel-webview"
import {
  createA2UIContextPanelRenderer,
  createChatContextPanelRenderer,
  declarativeFirstActivate,
} from "@/components/plugins/plugin-declarative-context-panel"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { attachContextPanelWebviewRpc } from "@/lib/plugin/bridge/context-panel-webview-rpc"
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

/**
 * RPC servers attached for webview-backed panels, torn down on unregister so a
 * disabled plugin's frames stop reaching the context-panel API.
 */
const webviewRpcDisposers = new Map<string, Array<() => void>>()

function disposeWebviewRpc(pluginId: string): void {
  const disposers = webviewRpcDisposers.get(pluginId)
  if (!disposers) return
  webviewRpcDisposers.delete(pluginId)
  for (const dispose of disposers) dispose()
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
  disposeWebviewRpc(manifest.id)
  const importer = options.importer ?? DEFAULT_IMPORTER
  const errors: ContextPanelBridgeError[] = []
  let registered = 0

  for (const [index, def] of defs.entries()) {
    try {
      const denied = requiredPermissions(manifest, index).find(
        (permission) => !options.hasPermission(permission)
      )
      if (denied) throw new Error(`Permission denied: ${denied} is required`)

      let exported: ComponentType<ContextPanelRenderProps>
      let onFirstActivate: ContextPanelDefinition["onFirstActivate"]
      let onRestore: ContextPanelDefinition["onRestore"]
      let getBadge: ContextPanelDefinition["getBadge"]
      if (def.kind === "a2ui") {
        // Declarative: nothing to import. The body is a surface the plugin
        // pushes with `ctx.a2ui.*`, and `activateTool` is what tells it to.
        exported = createA2UIContextPanelRenderer(manifest.id, def)
        onFirstActivate = declarativeFirstActivate(manifest.id, def)
      } else if (def.kind === "chat") {
        exported = createChatContextPanelRenderer(manifest.id, def)
      } else if (def.webview) {
        // Webview-backed: no module to import — the body is the referenced
        // webview's iframe, resolved lazily from the registry at render time
        // (the webview bridge runs AFTER this one in the module-bridge map).
        exported = createContextPanelWebviewRenderer(manifest.id, def.webview, def.label)
        const release = attachContextPanelWebviewRpc(manifest.id, def.webview, {
          hasPermission: options.hasPermission,
        })
        const disposers = webviewRpcDisposers.get(manifest.id) ?? []
        disposers.push(release)
        webviewRpcDisposers.set(manifest.id, disposers)
      } else {
        if (!def.entry || !def.export) {
          throw new Error("React context panels require both entry and export")
        }
        const entry = resolvePluginPath(installRoot, def.entry)
        const importedModule = await importer(entry)
        const moduleExport = importedModule[def.export]
        if (typeof moduleExport !== "function") {
          throw new Error(`entry "${def.entry}" has no React export named "${def.export}"`)
        }
        exported = moduleExport as ComponentType<ContextPanelRenderProps>
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
        onFirstActivate = optionalExport(def.onFirstActivateExport, "onFirstActivate") as
          ContextPanelDefinition["onFirstActivate"] | undefined
        onRestore = optionalExport(def.onRestoreExport, "onRestore") as
          ContextPanelDefinition["onRestore"] | undefined
        getBadge = optionalExport(def.getBadgeExport, "getBadge") as
          ContextPanelDefinition["getBadge"] | undefined
      }
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
        // A chat panel renders a conversation, so the scope is not the
        // author's to decline: without it the panel mounts with no session and
        // renders an empty pane. Every other kind keeps the manifest's answer.
        requiresChatScope: def.kind === "chat" ? true : def.requiresChatScope,
        preferredMode: def.preferredMode,
        retention: def.retention ?? "stateful",
        renderer: exported,
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
  disposeWebviewRpc(pluginId)
}

import type { ComponentType } from "react"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import {
  getActiveContextResource,
  revealPluginContextPanel,
  subscribeActiveContext,
} from "@/lib/context-workbench/active-context"
import type {
  ContextActivity,
  ContextCapability,
  ContextPanelDefinition,
  ContextPanelMode,
  ContextPanelRenderProps,
  ContextPanelRetention,
  ContextResource,
} from "@/types/context-workbench"

type ContextResourceKind = ContextResource["kind"]

export interface PluginContextPanelRegistration {
  id: string
  activity: ContextActivity
  label: string
  labelKey: string
  resourceKinds: ContextResourceKind[]
  requiredCapabilities?: ContextCapability[]
  requiredPermissions?: string[]
  preferredMode?: ContextPanelMode
  retention?: ContextPanelRetention
  order?: number
  renderer: ComponentType<ContextPanelRenderProps>
  onFirstActivate?: ContextPanelDefinition["onFirstActivate"]
  onRestore?: ContextPanelDefinition["onRestore"]
}

export interface PluginContextPanelAPI {
  register: (registration: PluginContextPanelRegistration) => () => void
  reveal: (panelId: string) => boolean
  getActiveContext: () => ContextResource | null
  onDidChangeActiveContext: (listener: (context: ContextResource | null) => void) => () => void
}

export const CONTEXT_RESOURCE_READ_PERMISSIONS: Record<ContextResourceKind, string> = {
  "project-file": "project:read",
  "canvas-document": "canvas:read",
  artifact: "artifact:read",
  workflow: "workflow:read",
}

export function createContextPanelAPI(
  pluginId: string,
  hasPermission: (permission: string) => boolean
): PluginContextPanelAPI {
  const getPermittedActiveContext = (): ContextResource | null => {
    const context = getActiveContextResource()
    if (!context) return null
    return hasPermission("extension:ui") &&
      hasPermission(CONTEXT_RESOURCE_READ_PERMISSIONS[context.kind])
      ? context
      : null
  }
  return {
    register(registration) {
      const required = [
        "extension:ui",
        ...registration.resourceKinds.map((kind) => CONTEXT_RESOURCE_READ_PERMISSIONS[kind]),
        ...(registration.requiredPermissions ?? []),
      ].filter((permission, index, permissions) => permissions.indexOf(permission) === index)
      const denied = required.find((permission) => !hasPermission(permission))
      if (denied) {
        throw new Error(`Permission denied: ${denied} is required to register a context panel`)
      }

      return contextPanelRegistry.register({
        id: `${pluginId}:${registration.id}`,
        activity: registration.activity,
        labelKey: registration.labelKey,
        label: registration.label,
        order: registration.order,
        appliesTo: (resource) => registration.resourceKinds.includes(resource.kind),
        requiredCapabilities: registration.requiredCapabilities,
        requiredPermissions: undefined,
        hasRequiredPermissions: () => required.every((permission) => hasPermission(permission)),
        preferredMode: registration.preferredMode,
        retention: registration.retention ?? "stateful",
        renderer: registration.renderer,
        onFirstActivate: registration.onFirstActivate,
        onRestore: registration.onRestore,
        pluginId,
      })
    },
    reveal: (panelId) => revealPluginContextPanel(pluginId, panelId),
    getActiveContext: getPermittedActiveContext,
    onDidChangeActiveContext(listener) {
      return subscribeActiveContext(() => listener(getPermittedActiveContext()))
    },
  }
}

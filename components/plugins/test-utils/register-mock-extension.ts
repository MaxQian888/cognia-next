import type { ComponentType } from "react"
import { clearPluginExtensions, createExtensionAPI } from "@/lib/plugin/api"
import type { CanonicalExtensionPoint } from "@/lib/plugin/contracts/plugin-points"
import type { ExtensionProps } from "@/types/plugin/plugin"

let counter = 0
const activePluginIds = new Set<string>()

interface RegisterOptions {
  priority?: number
}

interface RegisteredMock {
  pluginId: string
  unregister: () => void
}

export function registerMockExtension(
  point: CanonicalExtensionPoint,
  Component: ComponentType<ExtensionProps> = () => null,
  options: RegisterOptions = {}
): RegisteredMock {
  const pluginId = `__mock-plugin-${++counter}`
  activePluginIds.add(pluginId)
  const api = createExtensionAPI(pluginId)
  const unregister = api.registerExtension(point, Component, options)
  return {
    pluginId,
    unregister: () => {
      unregister()
      activePluginIds.delete(pluginId)
    },
  }
}

export function clearAllMockExtensions(): void {
  for (const pluginId of activePluginIds) {
    clearPluginExtensions(pluginId)
  }
  activePluginIds.clear()
}

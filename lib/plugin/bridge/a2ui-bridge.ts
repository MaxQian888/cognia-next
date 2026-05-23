/**
 * Plugin A2UI Bridge - Connects plugin system with A2UI rendering
 */

import React from "react"
import type {
  PluginA2UIComponent,
  A2UITemplateDef,
  A2UIPluginComponentProps,
  PluginContext,
} from "@/types/plugin"
import type { A2UISurfaceType } from "@/types/artifact/a2ui"
import { useA2UIStore } from "@/stores/a2ui"
import { usePluginStore } from "@/stores/plugin-runtime"
import { registerComponent, unregisterComponent } from "@/lib/a2ui/catalog"
import { globalEventEmitter } from "@/lib/a2ui/events"
import type { PluginRegistry } from "../core/registry"
import type { PluginLifecycleHooks } from "../messaging/hooks-system"
import { loggers } from "../core/logger"

// =============================================================================
// Types
// =============================================================================

interface A2UIBridgeConfig {
  registry: PluginRegistry
  hooksManager: PluginLifecycleHooks
  contextResolver?: (pluginId: string) => PluginContext | undefined
}

// =============================================================================
// Plugin A2UI Bridge
// =============================================================================

export class PluginA2UIBridge {
  private config: A2UIBridgeConfig
  private registeredComponents: Map<string, string> = new Map() // type -> pluginId
  private registeredTemplates: Map<string, string> = new Map() // templateId -> pluginId
  private missingContextWarnings: Set<string> = new Set()
  private unsubscribers: Array<() => void> = []

  constructor(config: A2UIBridgeConfig) {
    this.config = config
    this.setupEventListeners()
  }

  // ===========================================================================
  // Setup
  // ===========================================================================

  private setupEventListeners(): void {
    // Surface lifecycle forwarding
    const unsubscribe = useA2UIStore.subscribe((state, prevState) => {
      const currentSurfaces = Object.keys(state.surfaces)
      const prevSurfaces = Object.keys(prevState.surfaces)

      for (const surfaceId of currentSurfaces) {
        if (!prevSurfaces.includes(surfaceId)) {
          const surface = state.surfaces[surfaceId]
          this.config.hooksManager.dispatchOnA2UISurfaceCreate(
            surfaceId,
            surface.type as A2UISurfaceType
          )
        }
      }

      // Deleted surfaces
      for (const surfaceId of prevSurfaces) {
        if (!currentSurfaces.includes(surfaceId)) {
          this.config.hooksManager.dispatchOnA2UISurfaceDestroy(surfaceId)
        }
      }
    })

    const unsubscribeAction = globalEventEmitter.onAction((action) => {
      void this.config.hooksManager.dispatchOnA2UIAction({
        surfaceId: action.surfaceId,
        action: action.action,
        componentId: action.componentId,
        data: action.data,
      })
    })

    const unsubscribeDataChange = globalEventEmitter.onDataChange((change) => {
      this.config.hooksManager.dispatchOnA2UIDataChange({
        surfaceId: change.surfaceId,
        path: change.path,
        value: change.value,
      })
    })

    this.unsubscribers.push(unsubscribe, unsubscribeAction, unsubscribeDataChange)
  }

  // ===========================================================================
  // Component Registration
  // ===========================================================================

  /**
   * Register a plugin component with A2UI
   */
  registerComponent(pluginId: string, component: PluginA2UIComponent): void {
    const { type, metadata } = component

    // Check for conflicts
    if (this.registeredComponents.has(type)) {
      const existingPluginId = this.registeredComponents.get(type)
      loggers.manager.warn(
        `Component type "${type}" already registered by plugin "${existingPluginId}". ` +
          `Overwriting with plugin "${pluginId}".`
      )
    }

    // Create wrapper component that provides plugin context
    const WrappedComponent = this.createWrappedComponent(pluginId, component)

    // Register with A2UI catalog
    registerComponent(type as never, WrappedComponent as never, {
      description: metadata.description,
    })

    // Track registration
    this.registeredComponents.set(type, pluginId)
    this.config.registry.registerComponent(pluginId, component)
    usePluginStore.getState().registerPluginComponent(pluginId, component)
  }

  /**
   * Unregister a plugin component
   */
  unregisterComponent(componentType: string): void {
    const ownerPluginId = this.registeredComponents.get(componentType)
    if (!ownerPluginId) {
      return
    }

    unregisterComponent(componentType as never)
    this.registeredComponents.delete(componentType)
    this.config.registry.unregisterComponent(componentType)
    usePluginStore.getState().unregisterPluginComponent(ownerPluginId, componentType)
  }

  /**
   * Unregister all components from a plugin
   */
  unregisterPluginComponents(pluginId: string): void {
    for (const [type, ownerPluginId] of this.registeredComponents.entries()) {
      if (ownerPluginId === pluginId) {
        this.unregisterComponent(type)
      }
    }
  }

  /**
   * Create a wrapped component with plugin context
   */
  private createWrappedComponent(
    pluginId: string,
    pluginComponent: PluginA2UIComponent
  ): React.ComponentType<A2UIPluginComponentProps> {
    const OriginalComponent = pluginComponent.component
    const missingContextWarnings = this.missingContextWarnings
    const contextResolver = this.config.contextResolver

    // Return a wrapper that injects plugin context
    return function PluginComponentWrapper(props: A2UIPluginComponentProps) {
      const resolvedContext = contextResolver?.(pluginId)
      if (!resolvedContext) {
        const warningKey = `${pluginId}:${pluginComponent.type}`
        if (!missingContextWarnings.has(warningKey)) {
          missingContextWarnings.add(warningKey)
          loggers.manager.error(
            `[PluginA2UIBridge] Missing plugin context for component "${pluginComponent.type}" from plugin "${pluginId}". Rendering degraded fallback.`
          )
        }

        return React.createElement(
          "div",
          {
            role: "alert",
            "data-plugin-a2ui-fallback": pluginId,
            className:
              "rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive",
          },
          `Plugin component "${pluginComponent.type}" is unavailable because plugin context is missing.`
        )
      }

      const enhancedProps: A2UIPluginComponentProps = {
        ...props,
        pluginContext: resolvedContext,
      }

      // Use React.createElement instead of JSX (this is a .ts file)
      return React.createElement(OriginalComponent, enhancedProps)
    }
  }

  // ===========================================================================
  // Template Registration
  // ===========================================================================

  /**
   * Register a surface template
   */
  registerTemplate(pluginId: string, template: A2UITemplateDef): void {
    const templateId = `${pluginId}:${template.id}`

    if (this.registeredTemplates.has(templateId)) {
      loggers.manager.warn(`Template "${templateId}" already registered. Overwriting.`)
    }

    this.registeredTemplates.set(templateId, pluginId)
    this.config.registry.registerTemplate(pluginId, template)
  }

  /**
   * Unregister a template
   */
  unregisterTemplate(templateId: string): void {
    if (!this.registeredTemplates.has(templateId)) {
      return
    }

    this.registeredTemplates.delete(templateId)
    this.config.registry.unregisterTemplate(templateId)
  }

  /**
   * Unregister all templates from a plugin
   */
  unregisterPluginTemplates(pluginId: string): void {
    for (const [templateId, ownerPluginId] of this.registeredTemplates.entries()) {
      if (ownerPluginId === pluginId) {
        this.unregisterTemplate(templateId)
      }
    }
  }

  // ===========================================================================
  // Surface Operations
  // ===========================================================================

  /**
   * Create a surface from a template
   */
  createSurfaceFromTemplate(
    templateId: string,
    surfaceId: string,
    dataOverrides?: Record<string, unknown>
  ): void {
    const template = this.config.registry.getTemplate(templateId)
    if (!template) {
      throw new Error(`Template not found: ${templateId}`)
    }

    const a2uiStore = useA2UIStore.getState()

    // Create surface
    a2uiStore.createSurface(surfaceId, template.surfaceType, {
      title: template.name,
    })

    // Update components
    a2uiStore.processMessage({
      type: "updateComponents",
      surfaceId,
      components: template.components,
    })

    // Update data model
    const dataModel = {
      ...template.dataModel,
      ...dataOverrides,
    }

    a2uiStore.processMessage({
      type: "dataModelUpdate",
      surfaceId,
      data: dataModel,
      merge: false,
    })

    a2uiStore.processMessage({
      type: "surfaceReady",
      surfaceId,
    })
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  /**
   * Get all registered component types
   */
  getRegisteredComponentTypes(): string[] {
    return Array.from(this.registeredComponents.keys())
  }

  /**
   * Get all registered templates
   */
  getRegisteredTemplates(): A2UITemplateDef[] {
    return this.config.registry.getAllTemplates()
  }

  /**
   * Get templates by category
   */
  getTemplatesByCategory(category: string): A2UITemplateDef[] {
    return this.config.registry.getTemplatesByCategory(category)
  }

  /**
   * Check if a component type is registered by a plugin
   */
  isPluginComponent(componentType: string): boolean {
    return this.registeredComponents.has(componentType)
  }

  /**
   * Get the plugin ID that registered a component
   */
  getComponentPluginId(componentType: string): string | undefined {
    return this.registeredComponents.get(componentType)
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe()
    }
    this.unsubscribers = []

    // Unregister all components
    for (const type of this.registeredComponents.keys()) {
      unregisterComponent(type as never)
    }
    this.registeredComponents.clear()
    this.registeredTemplates.clear()
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createPluginA2UIBridge(config: A2UIBridgeConfig): PluginA2UIBridge {
  return new PluginA2UIBridge(config)
}

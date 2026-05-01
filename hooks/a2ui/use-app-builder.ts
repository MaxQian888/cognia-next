/**
 * useA2UIAppBuilder Hook
 * Provides functionality for building and managing A2UI mini-apps
 *
 * Split into sub-modules for maintainability:
 * - app-builder/types.ts — Shared type definitions
 * - app-builder/persistence.ts — localStorage read/write
 * - app-builder/action-handlers.ts — Default action handlers for built-in templates
 * - app-builder/import-export.ts — App serialization and file I/O
 * - app-builder/share.ts — Share codes, URLs, clipboard, social sharing
 */

import { useCallback, useMemo } from "react"
import { useA2UI } from "./use-a2ui"
import { useA2UIStore } from "@/stores/a2ui"
import {
  appTemplates,
  getTemplateById,
  getTemplatesByCategory,
  searchTemplates,
  createAppFromTemplate,
  generateTemplateId,
  type A2UIAppTemplate,
} from "@/lib/a2ui/templates"
import type {
  A2UIComponent,
  A2UIUserAction,
  A2UIDataModelChange,
  A2UISurfaceType,
} from "@/types/a2ui/schema"

// Re-export types from sub-modules for backward compatibility
export type { A2UIAppInstance, A2UIAppAuthor, A2UIAppStats } from "./app-builder/types"
import type { A2UIAppInstance } from "./app-builder/types"
import { getAppInstancesCache, saveAppInstances } from "./app-builder/persistence"
import { useAppActionHandlers } from "./app-builder/action-handlers"
import { useAppImportExport } from "./app-builder/import-export"
import { useAppShare } from "./app-builder/share"

/**
 * App builder options
 */
interface UseA2UIAppBuilderOptions {
  onAction?: (action: A2UIUserAction) => void
  onDataChange?: (change: A2UIDataModelChange) => void
  onAppCreated?: (appId: string, templateId: string) => void
  onAppDeleted?: (appId: string) => void
}

/**
 * useA2UIAppBuilder Hook
 * Composes sub-module hooks for action handling, import/export, and sharing
 */
export function useA2UIAppBuilder(options: UseA2UIAppBuilderOptions = {}) {
  const { onAction, onDataChange, onAppCreated, onAppDeleted } = options

  const a2ui = useA2UI({ onAction, onDataChange })
  const surfaces = useA2UIStore((state) => state.surfaces)
  const deleteSurfaceStore = useA2UIStore((state) => state.deleteSurface)

  // ========== Core App CRUD ==========

  const createFromTemplate = useCallback(
    (templateId: string, customName?: string): string | null => {
      const template = getTemplateById(templateId)
      if (!template) return null

      const { surfaceId, messages } = createAppFromTemplate(template)
      a2ui.processMessages(messages)

      const instance: A2UIAppInstance = {
        id: surfaceId,
        templateId,
        name: customName || template.name,
        createdAt: Date.now(),
        lastModified: Date.now(),
      }
      const instances = getAppInstancesCache()
      instances.set(surfaceId, instance)
      saveAppInstances(instances)
      onAppCreated?.(surfaceId, templateId)
      return surfaceId
    },
    [a2ui, onAppCreated]
  )

  const createCustomApp = useCallback(
    (
      name: string,
      components: A2UIComponent[],
      dataModel: Record<string, unknown> = {}
    ): string | null => {
      const surfaceId = generateTemplateId("custom")
      a2ui.createQuickSurface(surfaceId, components, dataModel, {
        type: "inline" as A2UISurfaceType,
        title: name,
      })

      const instance: A2UIAppInstance = {
        id: surfaceId,
        templateId: "custom",
        name,
        createdAt: Date.now(),
        lastModified: Date.now(),
      }
      const instances = getAppInstancesCache()
      instances.set(surfaceId, instance)
      saveAppInstances(instances)
      onAppCreated?.(surfaceId, "custom")
      return surfaceId
    },
    [a2ui, onAppCreated]
  )

  const duplicateApp = useCallback(
    (appId: string, newName?: string): string | null => {
      const surface = surfaces[appId]
      const instance = getAppInstancesCache().get(appId)
      if (!surface) return null

      const components = Object.values(surface.components)
      const name = newName || `${instance?.name || "App"} (Copy)`
      return createCustomApp(name, components, surface.dataModel)
    },
    [surfaces, createCustomApp]
  )

  const deleteApp = useCallback(
    (appId: string): void => {
      deleteSurfaceStore(appId)
      const instances = getAppInstancesCache()
      instances.delete(appId)
      saveAppInstances(instances)
      onAppDeleted?.(appId)
    },
    [deleteSurfaceStore, onAppDeleted]
  )

  const renameApp = useCallback((appId: string, newName: string): void => {
    const instances = getAppInstancesCache()
    const instance = instances.get(appId)
    if (instance) {
      instance.name = newName
      instance.lastModified = Date.now()
      saveAppInstances(instances)
    }
  }, [])

  const getAppInstance = useCallback((appId: string): A2UIAppInstance | undefined => {
    return getAppInstancesCache().get(appId)
  }, [])

  const getAllApps = useCallback((): A2UIAppInstance[] => {
    const instances = getAppInstancesCache()
    const validApps: A2UIAppInstance[] = []
    for (const [id, instance] of instances) {
      if (surfaces[id]) validApps.push(instance)
    }
    return validApps.sort((a, b) => b.lastModified - a.lastModified)
  }, [surfaces])

  // ========== App Data ==========

  const getAppData = useCallback(
    (appId: string): Record<string, unknown> | undefined => surfaces[appId]?.dataModel,
    [surfaces]
  )

  const setAppData = useCallback(
    (appId: string, path: string, value: unknown): void => {
      a2ui.setDataValue(appId, path, value)
      const instances = getAppInstancesCache()
      const instance = instances.get(appId)
      if (instance) {
        instance.lastModified = Date.now()
        saveAppInstances(instances)
      }
    },
    [a2ui]
  )

  const resetAppData = useCallback(
    (appId: string): void => {
      const instance = getAppInstancesCache().get(appId)
      if (!instance) return
      const template = getTemplateById(instance.templateId)
      if (template) {
        a2ui.processMessages([
          {
            type: "dataModelUpdate",
            surfaceId: appId,
            data: template.dataModel,
            merge: false,
          },
        ])
      }
    },
    [a2ui]
  )

  // ========== Composed Sub-Hooks ==========

  const { handleAppAction } = useAppActionHandlers({
    getAppData,
    setAppData,
    resetAppData,
    surfaces: surfaces as Record<string, { dataModel: Record<string, unknown> }>,
    setDataValue: a2ui.setDataValue,
    onAction,
  })

  const importExport = useAppImportExport({
    surfaces,
    getAllApps,
    onAppCreated,
    createQuickSurface: a2ui.createQuickSurface,
  })

  const share = useAppShare({
    exportApp: importExport.exportApp,
    getAppInstance,
  })

  // ========== Metadata / Thumbnail / Stats / Publish ==========

  const updateAppMetadata = useCallback(
    (appId: string, metadata: Partial<A2UIAppInstance>): void => {
      const instances = getAppInstancesCache()
      const instance = instances.get(appId)
      if (instance) {
        const updatedInstance: A2UIAppInstance = {
          ...instance,
          ...metadata,
          id: instance.id,
          createdAt: instance.createdAt,
          lastModified: Date.now(),
        }
        instances.set(appId, updatedInstance)
        saveAppInstances(instances)
      }
    },
    []
  )

  const setAppThumbnail = useCallback((appId: string, thumbnail: string): void => {
    const instances = getAppInstancesCache()
    const instance = instances.get(appId)
    if (instance) {
      instance.thumbnail = thumbnail
      instance.thumbnailUpdatedAt = Date.now()
      instance.lastModified = Date.now()
      saveAppInstances(instances)
    }
  }, [])

  const clearAppThumbnail = useCallback((appId: string): void => {
    const instances = getAppInstancesCache()
    const instance = instances.get(appId)
    if (instance) {
      delete instance.thumbnail
      delete instance.thumbnailUpdatedAt
      instance.lastModified = Date.now()
      saveAppInstances(instances)
    }
  }, [])

  const incrementAppViews = useCallback((appId: string): void => {
    const instances = getAppInstancesCache()
    const instance = instances.get(appId)
    if (instance) {
      if (!instance.stats) instance.stats = {}
      instance.stats.views = (instance.stats.views || 0) + 1
      saveAppInstances(instances)
    }
  }, [])

  const incrementAppUses = useCallback((appId: string): void => {
    const instances = getAppInstancesCache()
    const instance = instances.get(appId)
    if (instance) {
      if (!instance.stats) instance.stats = {}
      instance.stats.uses = (instance.stats.uses || 0) + 1
      saveAppInstances(instances)
    }
  }, [])

  const prepareForPublish = useCallback((appId: string): { valid: boolean; missing: string[] } => {
    const instance = getAppInstancesCache().get(appId)
    const missing: string[] = []
    if (!instance) return { valid: false, missing: ["App not found"] }
    if (!instance.name || instance.name.trim().length < 2)
      missing.push("name (at least 2 characters)")
    if (!instance.description || instance.description.trim().length < 10)
      missing.push("description (at least 10 characters)")
    if (!instance.thumbnail) missing.push("thumbnail")
    if (!instance.category) missing.push("category")
    if (!instance.version) missing.push("version")
    return { valid: missing.length === 0, missing }
  }, [])

  // Memoized templates
  const templates = useMemo(() => appTemplates, [])

  // Wrap share.importFromShareCode to inject importApp dependency
  const importFromShareCode = useCallback(
    (shareCode: string): string | null => {
      return share.importFromShareCode(shareCode, importExport.importApp)
    },
    [share, importExport.importApp]
  )

  return {
    // Template management
    templates,
    getTemplate: getTemplateById,
    getTemplatesByCategory,
    searchTemplates,

    // App creation
    createFromTemplate,
    createCustomApp,
    duplicateApp,

    // App management
    deleteApp,
    renameApp,
    getAppInstance,
    getAllApps,

    // App data
    getAppData,
    setAppData,
    resetAppData,

    // App actions
    handleAppAction,

    // Import/Export
    ...importExport,

    // Share
    generateShareCode: share.generateShareCode,
    importFromShareCode,
    generateShareUrl: share.generateShareUrl,
    copyAppToClipboard: share.copyAppToClipboard,
    getShareData: share.getShareData,
    shareAppNative: share.shareAppNative,
    getSocialShareUrls: share.getSocialShareUrls,

    // Metadata management
    updateAppMetadata,

    // Thumbnail management
    setAppThumbnail,
    clearAppThumbnail,

    // Statistics
    incrementAppViews,
    incrementAppUses,

    // App store preparation
    prepareForPublish,

    // Active app
    activeAppId: a2ui.activeSurfaceId,
    setActiveApp: a2ui.setActiveSurface,
  }
}

export type { A2UIAppTemplate }

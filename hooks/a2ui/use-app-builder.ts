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

import { useCallback, useEffect, useMemo, useRef } from "react"
import { useLocale } from "next-intl"
import { useA2UI } from "./use-a2ui"
import { useA2UIStore } from "@/stores/a2ui"
import { globalEventEmitter } from "@/lib/a2ui/events"
import { deepClone } from "@/lib/a2ui/data-model"
import {
  type A2UIAppTemplate,
  getLocalizedTemplateById,
  getLocalizedTemplates,
  getLocalizedTemplatesByCategory,
  searchLocalizedTemplates,
  createAppFromTemplate,
  generateTemplateId,
} from "@/lib/a2ui/templates"
import { defaultLocale, type Locale } from "@/i18n/config"
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
import {
  deleteApp as deletePersistedApp,
  listApps,
  patchAppMetadata,
  type A2UIAppMetadataPatch,
} from "@/lib/db/a2ui-apps"
import { loggers } from "@cognia/logging"

const log = loggers.app

function toMetadataPatch(instance: A2UIAppInstance): A2UIAppMetadataPatch {
  return {
    name: instance.name,
    lastModified: instance.lastModified,
    description: instance.description,
    version: instance.version,
    author: instance.author,
    category: instance.category,
    tags: instance.tags,
    thumbnail: instance.thumbnail,
    thumbnailUpdatedAt: instance.thumbnailUpdatedAt,
    stats: instance.stats,
    publishedAt: instance.publishedAt,
    isPublished: instance.isPublished,
    storeId: instance.storeId,
    screenshots: instance.screenshots,
    locale: instance.locale,
  }
}

// Module-level singleton for the built-in-action emitter subscription. The A2UI
// event emitter is global, so if two builders that both opted into
// `wireBuiltInActions` are mounted at once (e.g. the chat view and the Mini
// Apps hub inside a persistent shell), a per-hook subscription would run every
// handler twice — typing "1" once would append "11". Instead exactly ONE
// emitter listener exists at a time; it forwards to the most recently mounted
// builder's handler (all built-in handlers are equivalent — they mutate the
// store by surfaceId), and it is torn down only when the last opted-in builder
// unmounts.
let activeBuiltInHandler: ((action: A2UIUserAction) => void) | null = null
let builtInEmitterUnsub: (() => void) | null = null
let builtInRefCount = 0

function registerBuiltInActionHandler(handler: (action: A2UIUserAction) => void): () => void {
  builtInRefCount += 1
  activeBuiltInHandler = handler
  if (!builtInEmitterUnsub) {
    builtInEmitterUnsub = globalEventEmitter.onAction((action) => activeBuiltInHandler?.(action))
  }
  return () => {
    builtInRefCount -= 1
    if (builtInRefCount <= 0) {
      builtInRefCount = 0
      builtInEmitterUnsub?.()
      builtInEmitterUnsub = null
      activeBuiltInHandler = null
    }
  }
}

/**
 * App builder options
 */
interface UseA2UIAppBuilderOptions {
  onAction?: (action: A2UIUserAction) => void
  onDataChange?: (change: A2UIDataModelChange) => void
  onAppCreated?: (appId: string, templateId: string) => void
  onAppDeleted?: (appId: string) => void
  /**
   * Subscribe the built-in template action handlers (calculator / timer /
   * todo / …) to the global A2UI event emitter so rendered surfaces are
   * interactive. Opt-in because the emitter is global: enabling it on more
   * than one builder mounted at once would run every handler multiple times.
   * Enable it on exactly the one builder that owns a route's interactive
   * surfaces; leave it off for builders used only for CRUD/export (e.g. the
   * workspace toolbar). Unhandled actions still escalate to `onAction`.
   */
  wireBuiltInActions?: boolean
  /** Override the provider locale for deterministic embedding and tests. */
  locale?: Locale
}

/**
 * useA2UIAppBuilder Hook
 * Composes sub-module hooks for action handling, import/export, and sharing
 */
export function useA2UIAppBuilder(options: UseA2UIAppBuilderOptions = {}) {
  const providerLocale = useLocale()
  const locale = options.locale ?? (providerLocale === "zh-CN" ? "zh-CN" : defaultLocale)
  const { onAction, onDataChange, onAppCreated, onAppDeleted, wireBuiltInActions } = options

  // Data-model changes flow straight through to the consumer, but actions do
  // NOT subscribe here — the built-in handler owns the action subscription
  // (see below) and escalates unhandled actions to `onAction`. Subscribing
  // `onAction` here as well would double-dispatch, and any caller that chained
  // `handleAppAction` back into `onAction` would recurse without bound.
  const a2ui = useA2UI({ onDataChange })
  const surfaces = useA2UIStore((state) => state.surfaces)
  const deleteSurfaceStore = useA2UIStore((state) => state.deleteSurface)
  const restoreSurfaceStore = useA2UIStore((state) => state.restoreSurface)

  // ========== Core App CRUD ==========

  const createFromTemplate = useCallback(
    (templateId: string, customName?: string): string | null => {
      const template = getLocalizedTemplateById(templateId, locale)
      if (!template) return null

      const { surfaceId, messages } = createAppFromTemplate(template)
      a2ui.processMessages(messages)

      const instance: A2UIAppInstance = {
        id: surfaceId,
        templateId,
        name: customName || template.name,
        createdAt: Date.now(),
        lastModified: Date.now(),
        locale,
      }
      const instances = getAppInstancesCache()
      instances.set(surfaceId, instance)
      saveAppInstances(instances)
      onAppCreated?.(surfaceId, templateId)
      return surfaceId
    },
    [a2ui, locale, onAppCreated]
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
        locale,
      }
      const instances = getAppInstancesCache()
      instances.set(surfaceId, instance)
      saveAppInstances(instances)
      onAppCreated?.(surfaceId, "custom")
      return surfaceId
    },
    [a2ui, locale, onAppCreated]
  )

  const duplicateApp = useCallback(
    (appId: string, newName?: string): string | null => {
      const surface = surfaces[appId]
      const instance = getAppInstancesCache().get(appId)
      if (!surface) return null

      const name = newName || `${instance?.name || "App"} (Copy)`
      const surfaceId = generateTemplateId("custom")
      const now = Date.now()
      const restored = restoreSurfaceStore({
        ...surface,
        id: surfaceId,
        title: name,
        components: deepClone(surface.components),
        dataModel: deepClone(surface.dataModel),
        widget: deepClone(surface.widget),
        createdAt: now,
        updatedAt: now,
      })
      if (!restored) return null

      const duplicate: A2UIAppInstance = {
        id: surfaceId,
        templateId: "custom",
        name,
        createdAt: now,
        lastModified: now,
        description: instance?.description,
        version: instance?.version,
        author: deepClone(instance?.author),
        category: instance?.category,
        tags: deepClone(instance?.tags),
        thumbnail: instance?.thumbnail,
        thumbnailUpdatedAt: instance?.thumbnailUpdatedAt,
        screenshots: deepClone(instance?.screenshots),
        locale: instance?.locale ?? locale,
      }
      const instances = getAppInstancesCache()
      instances.set(surfaceId, duplicate)
      saveAppInstances(instances)
      onAppCreated?.(surfaceId, "custom")
      return surfaceId
    },
    [locale, onAppCreated, restoreSurfaceStore, surfaces]
  )

  const deleteApp = useCallback(
    async (appId: string): Promise<void> => {
      await deletePersistedApp(appId)
      deleteSurfaceStore(appId)
      const instances = getAppInstancesCache()
      instances.delete(appId)
      saveAppInstances(instances)
      onAppDeleted?.(appId)
    },
    [deleteSurfaceStore, onAppDeleted]
  )

  const persistInstanceUpdate = useCallback(
    async (
      appId: string,
      update: (instance: A2UIAppInstance) => A2UIAppInstance,
      touchLastModified = true
    ): Promise<boolean> => {
      const instances = getAppInstancesCache()
      const current = instances.get(appId)
      if (!current) return false

      const now = Date.now()
      const candidate = update({ ...current })
      const next: A2UIAppInstance = {
        ...candidate,
        id: current.id,
        templateId: current.templateId,
        createdAt: current.createdAt,
        lastModified: touchLastModified ? now : candidate.lastModified,
      }

      // Update the local cache immediately so consecutive mutations compose.
      // If the durable write fails, roll back only when no newer mutation has
      // replaced this exact object in the meantime.
      instances.set(appId, next)
      saveAppInstances(instances)
      try {
        await patchAppMetadata(appId, toMetadataPatch(next), now)
        return true
      } catch (error) {
        if (instances.get(appId) === next) {
          instances.set(appId, current)
          saveAppInstances(instances)
        }
        throw error
      }
    },
    []
  )

  const renameApp = useCallback(
    (appId: string, newName: string): Promise<boolean> =>
      persistInstanceUpdate(appId, (instance) => ({ ...instance, name: newName })),
    [persistInstanceUpdate]
  )

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

  /**
   * Rebuild renderable surfaces for saved apps whose component tree is absent
   * after a reload. Durable Dexie rows are authoritative for missing surfaces,
   * including custom apps. Legacy template-backed instances without a durable
   * row are regenerated deterministically. An already-renderable local surface
   * remains authoritative so hydration cannot overwrite unsaved edits. The
   * operation is idempotent and returns the number of recovered surfaces.
   */
  const hydratePersistedApps = useCallback(async (): Promise<number> => {
    const instances = getAppInstancesCache()
    let recovered = 0
    let cacheChanged = false
    const restoredIds = new Set<string>()

    try {
      const durableApps = await listApps()
      for (const row of durableApps) {
        if (!instances.has(row.id)) {
          const instance: A2UIAppInstance = {
            id: row.id,
            templateId: row.templateId,
            name: row.name,
            createdAt: row.createdAt,
            lastModified: row.lastModified,
            description: row.description,
            version: row.version,
            author: row.author,
            category: row.category,
            tags: row.tags,
            thumbnail: row.thumbnail,
            thumbnailUpdatedAt: row.thumbnailUpdatedAt,
            stats: row.stats,
            publishedAt: row.publishedAt,
            isPublished: row.isPublished,
            storeId: row.storeId,
            screenshots: row.screenshots,
            locale: row.locale ?? locale,
          }
          instances.set(row.id, instance)
          cacheChanged = true
        } else {
          const cached = instances.get(row.id)!
          if (!cached.locale) {
            cached.locale = row.locale ?? locale
            cacheChanged = true
          }
        }

        const localSurface = surfaces[row.id]
        const isRenderable =
          Boolean(localSurface?.ready) && Object.keys(localSurface?.components ?? {}).length > 0
        if (isRenderable) continue

        const restored = restoreSurfaceStore({
          id: row.id,
          type: "inline",
          catalogId: row.catalogId,
          title: row.name,
          widget: row.widget,
          components: row.components,
          dataModel: row.dataModel,
          rootId: row.rootId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          ready: true,
        })
        if (restored) {
          restoredIds.add(row.id)
          recovered++
        }
      }
    } catch (error) {
      log.error("A2UI AppBuilder: Failed to restore durable apps", error as Error)
    }

    for (const [id, instance] of instances) {
      if (!instance.locale) {
        instance.locale = locale
        cacheChanged = true
      }
      if (restoredIds.has(id)) continue
      const surface = surfaces[id]
      const renderable =
        Boolean(surface?.ready) && Object.keys(surface?.components ?? {}).length > 0
      if (renderable) continue

      const template = getLocalizedTemplateById(instance.templateId, instance.locale)
      if (!template) continue

      const { messages } = createAppFromTemplate(template, id)
      a2ui.processMessages(messages)
      recovered++
    }
    if (cacheChanged) saveAppInstances(instances)
    return recovered
  }, [surfaces, restoreSurfaceStore, a2ui, locale])

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
      const template = getLocalizedTemplateById(instance.templateId, instance.locale ?? locale)
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
    [a2ui, locale]
  )

  const getAppLocale = useCallback(
    (appId: string): Locale => getAppInstancesCache().get(appId)?.locale ?? locale,
    [locale]
  )

  // ========== Composed Sub-Hooks ==========

  const { handleAppAction } = useAppActionHandlers({
    getAppData,
    setAppData,
    resetAppData,
    surfaces: surfaces as Record<string, { dataModel: Record<string, unknown> }>,
    setDataValue: a2ui.setDataValue,
    getAppLocale,
    onAction,
  })

  // Drive the built-in handlers off the global emitter when the caller opts in.
  // A ref keeps the latest `handleAppAction` without re-registering the
  // subscription on every render (its identity changes with surface state).
  const handleAppActionRef = useRef(handleAppAction)
  useEffect(() => {
    handleAppActionRef.current = handleAppAction
  }, [handleAppAction])
  useEffect(() => {
    if (!wireBuiltInActions) return
    return registerBuiltInActionHandler((action) => handleAppActionRef.current(action))
  }, [wireBuiltInActions])

  const importExport = useAppImportExport({
    surfaces,
    getAllApps,
    onAppCreated,
    restoreSurface: restoreSurfaceStore,
    deleteSurface: deleteSurfaceStore,
    locale,
  })

  const share = useAppShare({
    exportApp: importExport.exportApp,
    getAppInstance,
  })

  // ========== Metadata / Thumbnail / Stats / Publish ==========

  const updateAppMetadata = useCallback(
    (appId: string, metadata: Partial<A2UIAppInstance>): Promise<boolean> =>
      persistInstanceUpdate(appId, (instance) => ({ ...instance, ...metadata })),
    [persistInstanceUpdate]
  )

  const setAppThumbnail = useCallback(
    (appId: string, thumbnail: string): Promise<boolean> =>
      persistInstanceUpdate(appId, (instance) => ({
        ...instance,
        thumbnail,
        thumbnailUpdatedAt: Date.now(),
      })),
    [persistInstanceUpdate]
  )

  const clearAppThumbnail = useCallback(
    (appId: string): Promise<boolean> =>
      persistInstanceUpdate(appId, (instance) => ({
        ...instance,
        thumbnail: undefined,
        thumbnailUpdatedAt: undefined,
      })),
    [persistInstanceUpdate]
  )

  const incrementAppViews = useCallback(
    (appId: string): Promise<boolean> =>
      persistInstanceUpdate(
        appId,
        (instance) => ({
          ...instance,
          stats: { ...instance.stats, views: (instance.stats?.views || 0) + 1 },
        }),
        false
      ),
    [persistInstanceUpdate]
  )

  const incrementAppUses = useCallback(
    (appId: string): Promise<boolean> =>
      persistInstanceUpdate(
        appId,
        (instance) => ({
          ...instance,
          stats: { ...instance.stats, uses: (instance.stats?.uses || 0) + 1 },
        }),
        false
      ),
    [persistInstanceUpdate]
  )

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

  // Memoized locale-owned template views. Canonical structures remain in
  // `appTemplates`; localization returns isolated overlays.
  const templates = useMemo(() => getLocalizedTemplates(locale), [locale])
  const getTemplate = useCallback(
    (templateId: string) => getLocalizedTemplateById(templateId, locale),
    [locale]
  )
  const getTemplatesByCategory = useCallback(
    (category: A2UIAppTemplate["category"]) => getLocalizedTemplatesByCategory(category, locale),
    [locale]
  )
  const searchTemplates = useCallback(
    (query: string) => searchLocalizedTemplates(query, locale),
    [locale]
  )

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
    getTemplate,
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
    hydratePersistedApps,

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

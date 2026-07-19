/**
 * A2UI App Builder - Import/Export Functions
 * Handles app serialization, file import/export, and backup
 */

import { useCallback } from "react"
import type { Locale } from "@/i18n/config"
import type { A2UISurfaceState } from "@/types/a2ui/schema"
import { generateTemplateId } from "@/lib/a2ui/templates"
import {
  A2UI_APP_EXPORT_VERSION,
  A2UI_MAX_IMPORT_BYTES,
  parseA2UIAppImport,
  parseA2UIBackupImport,
  type A2UIImportedApp,
} from "@/lib/a2ui/app-import"
import { loggers } from "@cognia/logging"
import type { A2UIAppInstance } from "./types"
import { getAppInstancesCache, saveAppInstances } from "./persistence"

const log = loggers.app

interface ImportExportDeps {
  surfaces: Record<string, A2UISurfaceState>
  restoreSurface: (surface: A2UISurfaceState) => boolean
  deleteSurface: (surfaceId: string) => void
  getAllApps: () => A2UIAppInstance[]
  onAppCreated?: (appId: string, templateId: string) => void
  locale: Locale
}

export function useAppImportExport(deps: ImportExportDeps) {
  const { surfaces, restoreSurface, deleteSurface, getAllApps, onAppCreated, locale } = deps

  const exportApp = useCallback(
    (appId: string): string | null => {
      const surface = surfaces[appId]
      const instance = getAppInstancesCache().get(appId)

      if (!surface || !instance) {
        log.error(`A2UI AppBuilder: Cannot export - app not found: ${appId}`)
        return null
      }

      const exportData = {
        version: A2UI_APP_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        app: {
          id: appId,
          name: instance.name,
          templateId: instance.templateId,
          locale: instance.locale ?? locale,
          description: instance.description,
          version: instance.version,
          author: instance.author,
          category: instance.category,
          tags: instance.tags,
          thumbnail: instance.thumbnail,
          thumbnailUpdatedAt: instance.thumbnailUpdatedAt,
          screenshots: instance.screenshots,
          components: Object.values(surface.components),
          dataModel: surface.dataModel,
          surfaceType: surface.type,
          catalogId: surface.catalogId,
          title: surface.title,
          widget: surface.widget,
          rootId: surface.rootId,
        },
      }

      return JSON.stringify(exportData, null, 2)
    },
    [locale, surfaces]
  )

  const downloadApp = useCallback(
    (appId: string, filename?: string): boolean => {
      const jsonData = exportApp(appId)
      if (!jsonData) return false

      const instance = getAppInstancesCache().get(appId)
      const safeName = (instance?.name || "app").replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_")
      const finalFilename = filename || `${safeName}_${Date.now()}.json`

      const blob = new Blob([jsonData], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = finalFilename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)

      return true
    },
    [exportApp]
  )

  const commitImportedApp = useCallback(
    (
      app: A2UIImportedApp,
      customName: string | undefined,
      restoreBackup: boolean
    ): string | null => {
      const instances = getAppInstancesCache()
      const baseId = generateTemplateId("imported")
      let newId = baseId
      let suffix = 2
      while (instances.has(newId) || surfaces[newId]) {
        newId = `${baseId}-${suffix}`
        suffix += 1
      }

      const now = Date.now()
      const name = customName?.trim() || app.name
      const {
        createdAt: sourceCreatedAt,
        lastModified: sourceLastModified,
        stats,
        publishedAt,
        isPublished,
        storeId,
        ...portableMetadata
      } = app.metadata
      const createdAt = restoreBackup ? (sourceCreatedAt ?? now) : now
      const lastModified = restoreBackup ? (sourceLastModified ?? createdAt) : now
      const backupMetadata = restoreBackup
        ? { stats, publishedAt, isPublished, storeId }
        : undefined
      const components = Object.fromEntries(
        app.components.map((component) => [component.id, component])
      )
      const restored = restoreSurface({
        id: newId,
        type: app.surfaceType,
        catalogId: app.catalogId,
        title: customName?.trim() || app.title,
        widget: app.widget,
        components,
        dataModel: app.dataModel,
        rootId: app.rootId,
        createdAt,
        updatedAt: lastModified,
        ready: true,
      })
      if (!restored) {
        log.error("A2UI AppBuilder: Validated import could not be restored")
        return null
      }

      const instance: A2UIAppInstance = {
        ...portableMetadata,
        ...backupMetadata,
        id: newId,
        templateId: app.templateId,
        name,
        createdAt,
        lastModified,
        locale: app.locale,
      }
      instances.set(newId, instance)
      return newId
    },
    [restoreSurface, surfaces]
  )

  const importApp = useCallback(
    (jsonData: string, customName?: string): string | null => {
      const parsed = parseA2UIAppImport(jsonData, locale)
      if (!parsed.success) {
        log.error(`A2UI AppBuilder: Import rejected (${parsed.error.code})`)
        return null
      }

      const committed = commitImportedApp(parsed.value, customName, false)
      if (!committed) return null
      saveAppInstances(getAppInstancesCache())
      onAppCreated?.(committed, "imported")
      return committed
    },
    [commitImportedApp, locale, onAppCreated]
  )

  const importAppFromFile = useCallback(
    (file: File): Promise<string | null> => {
      if (file.size > A2UI_MAX_IMPORT_BYTES) {
        log.error("A2UI AppBuilder: Import file exceeds the maximum payload size")
        return Promise.resolve(null)
      }
      return new Promise((resolve) => {
        const reader = new FileReader()
        reader.onload = (e) => {
          const content = e.target?.result as string
          if (content) {
            const appId = importApp(content)
            resolve(appId)
          } else {
            resolve(null)
          }
        }
        reader.onerror = () => {
          log.error("A2UI AppBuilder: File read error")
          resolve(null)
        }
        reader.readAsText(file)
      })
    },
    [importApp]
  )

  const exportAllApps = useCallback((): string => {
    const allApps = getAllApps()
    const skippedAppIds: string[] = []
    const exportedApps = allApps.flatMap((instance) => {
      const surface = surfaces[instance.id]
      if (!surface || !surface.components[surface.rootId]) {
        skippedAppIds.push(instance.id)
        return []
      }
      return [
        {
          ...instance,
          locale: instance.locale ?? locale,
          components: Object.values(surface.components),
          dataModel: surface.dataModel,
          surfaceType: surface.type,
          catalogId: surface.catalogId,
          title: surface.title,
          widget: surface.widget,
          rootId: surface.rootId,
        },
      ]
    })

    const backupData = {
      version: A2UI_APP_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      appCount: exportedApps.length,
      skippedAppIds,
      apps: exportedApps,
    }

    return JSON.stringify(backupData, null, 2)
  }, [getAllApps, locale, surfaces])

  const importAllApps = useCallback(
    (jsonData: string): number => {
      const parsed = parseA2UIBackupImport(jsonData, locale)
      if (!parsed.success) {
        log.error(`A2UI AppBuilder: Backup import rejected (${parsed.error.code})`)
        return 0
      }

      const committedIds: string[] = []
      for (const app of parsed.value.apps) {
        const committed = commitImportedApp(app, undefined, true)
        if (!committed) {
          const instances = getAppInstancesCache()
          for (const appId of committedIds) {
            deleteSurface(appId)
            instances.delete(appId)
          }
          saveAppInstances(instances)
          return 0
        }
        committedIds.push(committed)
      }

      saveAppInstances(getAppInstancesCache())
      for (const appId of committedIds) onAppCreated?.(appId, "imported")
      return committedIds.length
    },
    [commitImportedApp, deleteSurface, locale, onAppCreated]
  )

  return {
    exportApp,
    downloadApp,
    importApp,
    importAppFromFile,
    exportAllApps,
    importAllApps,
  }
}

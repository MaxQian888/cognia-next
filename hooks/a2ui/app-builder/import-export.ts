/**
 * A2UI App Builder - Import/Export Functions
 * Handles app serialization, file import/export, and backup
 */

import { useCallback } from "react"
import type { A2UIComponent, A2UISurfaceState, A2UISurfaceType } from "@/types/a2ui/schema"
import { generateTemplateId } from "@/lib/a2ui/templates"
import { loggers } from "@cognia/logging"
import type { A2UIAppInstance } from "./types"
import { getAppInstancesCache, saveAppInstances } from "./persistence"

const log = loggers.app

interface ImportExportDeps {
  surfaces: Record<string, A2UISurfaceState>
  createQuickSurface: (
    surfaceId: string,
    components: A2UIComponent[],
    dataModel?: Record<string, unknown>,
    opts?: { type?: A2UISurfaceType; title?: string }
  ) => void
  getAllApps: () => A2UIAppInstance[]
  onAppCreated?: (appId: string, templateId: string) => void
}

export function useAppImportExport(deps: ImportExportDeps) {
  const { surfaces, createQuickSurface, getAllApps, onAppCreated } = deps

  const exportApp = useCallback(
    (appId: string): string | null => {
      const surface = surfaces[appId]
      const instance = getAppInstancesCache().get(appId)

      if (!surface || !instance) {
        log.error(`A2UI AppBuilder: Cannot export - app not found: ${appId}`)
        return null
      }

      const exportData = {
        version: "1.0",
        exportedAt: new Date().toISOString(),
        app: {
          id: appId,
          name: instance.name,
          templateId: instance.templateId,
          components: Object.values(surface.components),
          dataModel: surface.dataModel,
          surfaceType: surface.type,
          title: surface.title,
        },
      }

      return JSON.stringify(exportData, null, 2)
    },
    [surfaces]
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

  const importApp = useCallback(
    (jsonData: string, customName?: string): string | null => {
      try {
        const parsed = JSON.parse(jsonData)

        if (!parsed.app || !parsed.app.components || !Array.isArray(parsed.app.components)) {
          log.error("A2UI AppBuilder: Invalid import format: missing app or components")
          return null
        }

        const { app } = parsed
        const newId = generateTemplateId("imported")
        const name = customName || app.name || "Imported App"

        createQuickSurface(newId, app.components, app.dataModel || {}, {
          type: app.surfaceType || "inline",
          title: app.title || name,
        })

        const instance: A2UIAppInstance = {
          id: newId,
          templateId: app.templateId || "imported",
          name,
          createdAt: Date.now(),
          lastModified: Date.now(),
        }

        const instances = getAppInstancesCache()
        instances.set(newId, instance)
        saveAppInstances(instances)

        onAppCreated?.(newId, "imported")
        return newId
      } catch (error) {
        log.error("A2UI AppBuilder: Import failed", error as Error)
        return null
      }
    },
    [createQuickSurface, onAppCreated]
  )

  const importAppFromFile = useCallback(
    (file: File): Promise<string | null> => {
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
    const exportedApps = allApps.map((instance) => {
      const surface = surfaces[instance.id]
      return {
        id: instance.id,
        name: instance.name,
        templateId: instance.templateId,
        components: surface ? Object.values(surface.components) : [],
        dataModel: surface?.dataModel || {},
        surfaceType: surface?.type || "inline",
        title: surface?.title,
        createdAt: instance.createdAt,
        lastModified: instance.lastModified,
      }
    })

    const backupData = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      appCount: exportedApps.length,
      apps: exportedApps,
    }

    return JSON.stringify(backupData, null, 2)
  }, [getAllApps, surfaces])

  const importAllApps = useCallback(
    (jsonData: string): number => {
      try {
        const parsed = JSON.parse(jsonData)

        if (!parsed.apps || !Array.isArray(parsed.apps)) {
          log.error("A2UI AppBuilder: Invalid backup format")
          return 0
        }

        let importedCount = 0
        for (const app of parsed.apps) {
          const singleAppJson = JSON.stringify({ version: "1.0", app })
          if (importApp(singleAppJson)) {
            importedCount++
          }
        }

        return importedCount
      } catch (error) {
        log.error("A2UI AppBuilder: Backup import failed", error as Error)
        return 0
      }
    },
    [importApp]
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

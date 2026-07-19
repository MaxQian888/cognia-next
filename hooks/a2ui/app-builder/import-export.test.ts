import { act, renderHook } from "@testing-library/react"
import type { A2UISurfaceState } from "@/types/a2ui/schema"
import { A2UI_APP_EXPORT_VERSION } from "@/lib/a2ui/app-import"
import { useAppImportExport } from "./import-export"

const mockCache = new Map()
const mockSaveAppInstances = jest.fn()

jest.mock("./persistence", () => ({
  getAppInstancesCache: () => mockCache,
  saveAppInstances: (...args: unknown[]) => mockSaveAppInstances(...args),
}))

jest.mock("@/lib/a2ui/templates", () => ({
  generateTemplateId: () => "imported-app",
}))

jest.mock("@cognia/logging", () => ({
  loggers: { app: { error: jest.fn() } },
}))

const surface: A2UISurfaceState = {
  id: "app-1",
  type: "panel",
  ready: true,
  rootId: "root",
  catalogId: "default",
  title: "Surface title",
  components: {
    root: { id: "root", component: "Column", children: ["label"] },
    label: { id: "label", component: "Text", text: "Hello" },
  },
  dataModel: { greeting: "hello" },
  createdAt: 10,
  updatedAt: 20,
}

function importPayload(name = "Imported app") {
  return JSON.stringify({
    version: A2UI_APP_EXPORT_VERSION,
    app: {
      name,
      templateId: "custom",
      components: Object.values(surface.components),
      dataModel: surface.dataModel,
      surfaceType: surface.type,
      rootId: surface.rootId,
      stats: { views: 99 },
      isPublished: true,
      storeId: "store-source",
    },
  })
}

describe("useAppImportExport", () => {
  beforeEach(() => {
    mockCache.clear()
    mockSaveAppInstances.mockClear()
  })

  it("exports complete instance and surface metadata", () => {
    mockCache.set("app-1", {
      id: "app-1",
      templateId: "custom",
      name: "Exported app",
      createdAt: 10,
      lastModified: 20,
      tags: ["demo"],
    })
    const { result } = renderHook(() =>
      useAppImportExport({
        surfaces: { "app-1": surface },
        restoreSurface: jest.fn(() => true),
        deleteSurface: jest.fn(),
        getAllApps: () => [],
        locale: "zh-CN",
      })
    )

    const exported = JSON.parse(result.current.exportApp("app-1")!)

    expect(exported).toMatchObject({
      version: A2UI_APP_EXPORT_VERSION,
      app: {
        id: "app-1",
        name: "Exported app",
        locale: "zh-CN",
        surfaceType: "panel",
        rootId: "root",
        dataModel: { greeting: "hello" },
      },
    })
    expect(exported.app.components).toHaveLength(2)
  })

  it("imports a portable copy without retaining publication identity", () => {
    const restoreSurface = jest.fn(() => true)
    const onAppCreated = jest.fn()
    const { result } = renderHook(() =>
      useAppImportExport({
        surfaces: {},
        restoreSurface,
        deleteSurface: jest.fn(),
        getAllApps: () => [],
        onAppCreated,
        locale: "en",
      })
    )

    let importedId: string | null = null
    act(() => {
      importedId = result.current.importApp(importPayload(), "Renamed import")
    })

    expect(importedId).toBe("imported-app")
    expect(restoreSurface).toHaveBeenCalledWith(
      expect.objectContaining({ id: "imported-app", title: "Renamed import", rootId: "root" })
    )
    expect(mockCache.get("imported-app")).toMatchObject({
      id: "imported-app",
      name: "Renamed import",
      templateId: "custom",
    })
    expect(mockCache.get("imported-app")).not.toHaveProperty("stats")
    expect(mockCache.get("imported-app")).not.toHaveProperty("isPublished")
    expect(mockCache.get("imported-app")).not.toHaveProperty("storeId")
    expect(mockSaveAppInstances).toHaveBeenCalledWith(mockCache)
    expect(onAppCreated).toHaveBeenCalledWith("imported-app", "imported")
  })

  it("rolls back every committed app when a backup restore fails", () => {
    const restoreSurface = jest.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
    const deleteSurface = jest.fn()
    const { result } = renderHook(() =>
      useAppImportExport({
        surfaces: {},
        restoreSurface,
        deleteSurface,
        getAllApps: () => [],
        locale: "en",
      })
    )
    const app = JSON.parse(importPayload()).app
    const backup = JSON.stringify({
      version: A2UI_APP_EXPORT_VERSION,
      apps: [
        { ...app, name: "First" },
        { ...app, name: "Second" },
      ],
    })

    let importedCount = -1
    act(() => {
      importedCount = result.current.importAllApps(backup)
    })

    expect(importedCount).toBe(0)
    expect(deleteSurface).toHaveBeenCalledWith("imported-app")
    expect(mockCache.has("imported-app")).toBe(false)
    expect(mockSaveAppInstances).toHaveBeenCalledWith(mockCache)
  })
})

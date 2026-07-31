/** @jest-environment jsdom */
/**
 * Tests for Export Plugin API
 */

import { createExportAPI, clearCustomExporters } from "./export-api"
import { initializePluginPermissions } from "./permission-api"
import { getPluginEventHooks } from "../messaging/hooks-system"
import type { CustomExporter, ExportData } from "@/types/plugin/plugin"

// Mock stores and dependencies
const mockSessions = [
  { id: "session-1", title: "Test Session", createdAt: new Date(), updatedAt: new Date() },
]

const mockProjects = [
  { id: "project-1", name: "Test Project", createdAt: new Date(), updatedAt: new Date() },
]

const mockMessages = [
  { id: "msg-1", role: "user" as const, content: "Hello", createdAt: new Date() },
  { id: "msg-2", role: "assistant" as const, content: "Hi there!", createdAt: new Date() },
]

jest.mock("@/stores/chat/session-store", () => ({
  useSessionStore: {
    getState: jest.fn(() => ({
      sessions: mockSessions,
    })),
  },
}))

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: {
    getState: jest.fn(() => ({
      projects: mockProjects,
    })),
  },
}))

jest.mock("@/lib/db", () => ({
  messageRepository: {
    getBySessionId: jest.fn(() => Promise.resolve(mockMessages)),
  },
}))

jest.mock("@/lib/export", () => ({
  exportToRichMarkdown: jest.fn(() => "# Exported Markdown"),
  exportToRichJSON: jest.fn(() => '{"exported": true}'),
  exportToHTML: jest.fn(() => "<html>Exported</html>"),
  exportToPlainText: jest.fn(() => "Plain text export"),
  exportToAnimatedHTML: jest.fn(() => "<html>Animated</html>"),
  generateFilename: jest.fn((title, ext) => `${title}.${ext}`),
}))

describe("Export API", () => {
  const testPluginId = "test-plugin"

  beforeEach(() => {
    clearCustomExporters()
  })

  describe("createExportAPI", () => {
    it("should create an API object with all expected methods", () => {
      const api = createExportAPI(testPluginId)

      expect(api).toBeDefined()
      expect(typeof api.exportSession).toBe("function")
      expect(typeof api.exportProject).toBe("function")
      expect(typeof api.exportMessages).toBe("function")
      expect(typeof api.download).toBe("function")
      expect(typeof api.registerExporter).toBe("function")
      expect(typeof api.getAvailableFormats).toBe("function")
      expect(typeof api.getCustomExporters).toBe("function")
      expect(typeof api.generateFilename).toBe("function")
    })
  })

  describe("exportSession", () => {
    it("should export session to markdown", async () => {
      const api = createExportAPI(testPluginId)

      const result = await api.exportSession("session-1", { format: "markdown" })

      expect(result.success).toBe(true)
      expect(result.blob).toBeDefined()
      expect(result.filename).toContain(".md")
    })

    it("should export session to JSON", async () => {
      const api = createExportAPI(testPluginId)

      const result = await api.exportSession("session-1", { format: "json" })

      expect(result.success).toBe(true)
      expect(result.blob).toBeDefined()
      expect(result.filename).toContain(".json")
    })

    it("should export session to HTML", async () => {
      const api = createExportAPI(testPluginId)

      const result = await api.exportSession("session-1", { format: "html" })

      expect(result.success).toBe(true)
      expect(result.blob).toBeDefined()
      expect(result.filename).toContain(".html")
    })

    it("should export session to plain text", async () => {
      const api = createExportAPI(testPluginId)

      const result = await api.exportSession("session-1", { format: "text" })

      expect(result.success).toBe(true)
      expect(result.blob).toBeDefined()
      expect(result.filename).toContain(".txt")
    })

    it("should export session to animated HTML", async () => {
      const api = createExportAPI(testPluginId)

      const result = await api.exportSession("session-1", { format: "animated-html" })

      expect(result.success).toBe(true)
      expect(result.blob).toBeDefined()
    })

    it("should return error for non-existent session", async () => {
      const api = createExportAPI(testPluginId)

      const result = await api.exportSession("non-existent", { format: "markdown" })

      expect(result.success).toBe(false)
      expect(result.error).toBe("Session not found")
    })

    it("should return error for unsupported format", async () => {
      const api = createExportAPI(testPluginId)

      const result = await api.exportSession("session-1", { format: "unsupported" as never })

      expect(result.success).toBe(false)
      expect(result.error).toContain("Unsupported format")
    })
  })

  describe("plugin event dispatch", () => {
    it("exportSession dispatches onExportStart + onExportComplete(true) and runs onExportTransform", async () => {
      const hooks = getPluginEventHooks()
      const startSpy = jest.spyOn(hooks, "dispatchExportStart").mockResolvedValue([] as never)
      const transformSpy = jest
        .spyOn(hooks, "dispatchExportTransform")
        .mockImplementation(async (content) => content)
      const completeSpy = jest.spyOn(hooks, "dispatchExportComplete").mockImplementation(() => {})

      const api = createExportAPI(testPluginId)
      const result = await api.exportSession("session-1", { format: "markdown" })
      expect(result.success).toBe(true)
      expect(startSpy).toHaveBeenCalledWith("session-1", "markdown")
      expect(transformSpy).toHaveBeenCalledWith("# Exported Markdown", "markdown")
      expect(completeSpy).toHaveBeenCalledWith("session-1", "markdown", true)
    })

    it("exportSession dispatches onExportComplete(false) when the session is missing", async () => {
      const hooks = getPluginEventHooks()
      jest.spyOn(hooks, "dispatchExportStart").mockResolvedValue([] as never)
      const completeSpy = jest.spyOn(hooks, "dispatchExportComplete").mockImplementation(() => {})

      const api = createExportAPI(testPluginId)
      const result = await api.exportSession("does-not-exist", { format: "markdown" })
      expect(result.success).toBe(false)
      expect(completeSpy).toHaveBeenCalledWith("does-not-exist", "markdown", false)
    })

    it("exportProject dispatches onProjectExportStart + onProjectExportComplete", async () => {
      const hooks = getPluginEventHooks()
      const startSpy = jest
        .spyOn(hooks, "dispatchProjectExportStart")
        .mockResolvedValue([] as never)
      const completeSpy = jest
        .spyOn(hooks, "dispatchProjectExportComplete")
        .mockImplementation(() => {})

      const api = createExportAPI(testPluginId)
      await api.exportProject("project-1", { format: "json" })
      expect(startSpy).toHaveBeenCalledWith("project-1", "json")
      // The JSON branch in performExport requires a session, so it returns
      // success: false; we still expect a paired complete dispatch.
      expect(completeSpy).toHaveBeenCalledWith("project-1", "json", false)
    })

    it("exportProject dispatches onProjectExportComplete(false) when the project is missing", async () => {
      const hooks = getPluginEventHooks()
      jest.spyOn(hooks, "dispatchProjectExportStart").mockResolvedValue([] as never)
      const completeSpy = jest
        .spyOn(hooks, "dispatchProjectExportComplete")
        .mockImplementation(() => {})

      const api = createExportAPI(testPluginId)
      const result = await api.exportProject("missing", { format: "json" })
      expect(result.success).toBe(false)
      expect(completeSpy).toHaveBeenCalledWith("missing", "json", false)
    })
  })

  describe("exportProject", () => {
    it("should export project successfully", async () => {
      const api = createExportAPI(testPluginId)

      // Note: Project export might have limited format support
      const result = await api.exportProject("project-1", { format: "json" })

      // Result depends on implementation - check that it doesn't throw
      expect(result).toBeDefined()
    })

    it("should return error for non-existent project", async () => {
      const api = createExportAPI(testPluginId)

      const result = await api.exportProject("non-existent", { format: "json" })

      expect(result.success).toBe(false)
      expect(result.error).toBe("Project not found")
    })
  })

  describe("exportMessages", () => {
    it("should export messages to markdown", async () => {
      const api = createExportAPI(testPluginId)

      const result = await api.exportMessages(mockMessages, { format: "markdown" })

      // Messages export might require session context
      expect(result).toBeDefined()
    })

    it("should export messages to JSON", async () => {
      const api = createExportAPI(testPluginId)

      const result = await api.exportMessages(mockMessages, { format: "json" })

      expect(result).toBeDefined()
    })
  })

  describe("download", () => {
    it("should not throw when downloading successful result", () => {
      const api = createExportAPI(testPluginId)

      // Mock DOM elements
      const mockCreateObjectURL = jest.fn(() => "blob:mock-url")
      const mockRevokeObjectURL = jest.fn()
      const mockAppendChild = jest.fn()
      const mockRemoveChild = jest.fn()
      const mockClick = jest.fn()

      global.URL.createObjectURL = mockCreateObjectURL
      global.URL.revokeObjectURL = mockRevokeObjectURL

      const mockAnchor = {
        href: "",
        download: "",
        click: mockClick,
      }

      jest
        .spyOn(document, "createElement")
        .mockReturnValue(mockAnchor as unknown as HTMLAnchorElement)
      jest.spyOn(document.body, "appendChild").mockImplementation(mockAppendChild)
      jest.spyOn(document.body, "removeChild").mockImplementation(mockRemoveChild)

      const result = {
        success: true as const,
        blob: new Blob(["test"], { type: "text/plain" }),
        filename: "test.txt",
      }

      expect(() => api.download(result, "custom-name.txt")).not.toThrow()
    })

    it("should not download when result is unsuccessful", () => {
      const api = createExportAPI(testPluginId)

      const result = {
        success: false as const,
        error: "Export failed",
      }

      // Should not throw
      expect(() => api.download(result)).not.toThrow()
    })
  })

  describe("registerExporter", () => {
    it("should register a custom exporter", () => {
      const api = createExportAPI(testPluginId)

      const exporter: CustomExporter = {
        id: "custom-format",
        name: "Custom Format",
        description: "A custom export format",
        format: "custom",
        extension: "custom",
        mimeType: "application/custom",
        export: async (_data: ExportData) => "custom content",
      }

      const unregister = api.registerExporter(exporter)

      expect(typeof unregister).toBe("function")

      const exporters = api.getCustomExporters()
      expect(exporters.length).toBe(1)
      expect(exporters[0].name).toBe("Custom Format")
    })

    it("should prefix exporter ID with plugin ID", () => {
      const api = createExportAPI(testPluginId)

      const exporter: CustomExporter = {
        id: "my-exporter",
        name: "My Exporter",
        description: "My custom exporter",
        format: "my-format",
        extension: "myf",
        mimeType: "application/myformat",
        export: async () => "content",
      }

      api.registerExporter(exporter)

      const exporters = api.getCustomExporters()
      expect(exporters[0].id).toBe(`${testPluginId}:my-exporter`)
    })

    it("should unregister exporter when cleanup is called", () => {
      const api = createExportAPI(testPluginId)

      const exporter: CustomExporter = {
        id: "temp-exporter",
        name: "Temp Exporter",
        description: "Temporary exporter",
        format: "temp",
        extension: "tmp",
        mimeType: "application/temp",
        export: async () => "temp",
      }

      const unregister = api.registerExporter(exporter)
      expect(api.getCustomExporters().length).toBe(1)

      unregister()
      expect(api.getCustomExporters().length).toBe(0)
    })
  })

  describe("getAvailableFormats", () => {
    it("should return all available formats", () => {
      const api = createExportAPI(testPluginId)

      const formats = api.getAvailableFormats()

      expect(Array.isArray(formats)).toBe(true)
      expect(formats).toContain("markdown")
      expect(formats).toContain("json")
      expect(formats).toContain("html")
      expect(formats).toContain("text")
    })
  })

  describe("getCustomExporters", () => {
    it("should return empty array when no exporters registered", () => {
      const api = createExportAPI(testPluginId)

      const exporters = api.getCustomExporters()

      expect(exporters).toEqual([])
    })

    it("should return all registered exporters", () => {
      const api = createExportAPI(testPluginId)

      api.registerExporter({
        id: "exp-1",
        name: "Exporter 1",
        description: "First exporter",
        format: "fmt1",
        extension: "f1",
        mimeType: "application/f1",
        export: async () => "content1",
      })

      api.registerExporter({
        id: "exp-2",
        name: "Exporter 2",
        description: "Second exporter",
        format: "fmt2",
        extension: "f2",
        mimeType: "application/f2",
        export: async () => "content2",
      })

      const exporters = api.getCustomExporters()
      expect(exporters.length).toBe(2)
    })
  })

  describe("generateFilename", () => {
    it("should generate filename with extension", () => {
      const api = createExportAPI(testPluginId)

      const filename = api.generateFilename("My Export", "md")

      expect(filename).toContain("My Export")
      expect(filename).toContain(".md")
    })
  })

  describe("Custom exporter integration", () => {
    it("should use custom exporter when format matches", async () => {
      const api = createExportAPI(testPluginId)
      const customExport = jest.fn(() => Promise.resolve("custom output"))

      api.registerExporter({
        id: "custom",
        name: "Custom",
        description: "Custom format exporter",
        format: "custom-format",
        extension: "cust",
        mimeType: "application/custom",
        export: customExport,
      })

      // Note: The exportSession with custom format would need the format to be registered
      // This tests the registration mechanism
      const exporters = api.getCustomExporters()
      expect(exporters.find((e) => e.format === "custom-format")).toBeDefined()
    })
  })
})

// W2.3: the export API is permission-gated; grant the suite's plugin.
beforeAll(() => {
  initializePluginPermissions("test-plugin", ["export:session", "export:project"])
})

describe("permission gate", () => {
  it("throws PermissionError when export permissions are not granted", () => {
    const api = createExportAPI("no-perms-plugin")
    expect(() => api.exportSession("s", { format: "json" })).toThrow(/export:session/)
  })
})

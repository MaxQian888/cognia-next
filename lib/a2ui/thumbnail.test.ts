/** @jest-environment jsdom */
/**
 * A2UI Thumbnail Generation Tests
 */

import {
  generatePlaceholderThumbnail,
  saveThumbnail,
  getThumbnail,
  deleteThumbnail,
  isThumbnailStale,
  getAllThumbnails,
  clearAllThumbnails,
  syncThumbnailsWithApps,
} from "./thumbnail"

// Mock localStorage
const mockLocalStorage: Record<string, string> = {}
const localStorageMock = {
  getItem: jest.fn((key: string) => mockLocalStorage[key] || null),
  setItem: jest.fn((key: string, value: string) => {
    mockLocalStorage[key] = value
  }),
  removeItem: jest.fn((key: string) => {
    delete mockLocalStorage[key]
  }),
  clear: jest.fn(() => {
    Object.keys(mockLocalStorage).forEach((key) => delete mockLocalStorage[key])
  }),
}

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
  writable: true,
})

// Mock html2canvas
jest.mock("html2canvas", () => ({
  __esModule: true,
  default: jest.fn(() =>
    Promise.resolve({
      width: 400,
      height: 300,
      toDataURL: jest.fn(() => "data:image/png;base64,mockImageData"),
    })
  ),
}))

describe("A2UI Thumbnail", () => {
  let toDataURLSpy: jest.SpyInstance
  let getContextSpy: jest.SpyInstance

  beforeAll(() => {
    toDataURLSpy = jest
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockImplementation(() => "data:image/png;base64,mockCanvasData")
    // jsdom doesn't ship a real 2D context. Stub a minimal one so the source's
    // `if (!ctx) return ""` early-out doesn't fire.
    const fake2dContext = {
      fillStyle: "",
      font: "",
      textAlign: "",
      textBaseline: "",
      createLinearGradient: jest.fn(() => ({ addColorStop: jest.fn() })),
      fillRect: jest.fn(),
      fillText: jest.fn(),
      beginPath: jest.fn(),
      arc: jest.fn(),
      fill: jest.fn(),
      drawImage: jest.fn(),
    } as unknown as CanvasRenderingContext2D
    getContextSpy = jest
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(() => fake2dContext as unknown as never)
  })

  afterAll(() => {
    toDataURLSpy.mockRestore()
    getContextSpy.mockRestore()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    Object.keys(mockLocalStorage).forEach((key) => delete mockLocalStorage[key])
  })

  describe("generatePlaceholderThumbnail", () => {
    it("should generate a data URL", () => {
      const result = generatePlaceholderThumbnail("TestIcon", "Test App")

      expect(result).toContain("data:image/")
    })

    it("should handle long titles by truncating", () => {
      const longTitle = "This is a very long application title that should be truncated"
      const result = generatePlaceholderThumbnail("Icon", longTitle)

      expect(result).toContain("data:image/")
    })

    it("should accept custom options", () => {
      const result = generatePlaceholderThumbnail("Icon", "App", {
        width: 300,
        height: 200,
        format: "jpeg",
      })

      expect(result).toContain("data:image/")
    })

    it("should return empty string if canvas context is not available", () => {
      // Mock document.createElement to return a canvas without context
      const originalCreateElement = document.createElement.bind(document)
      jest.spyOn(document, "createElement").mockImplementation((tagName: string) => {
        if (tagName === "canvas") {
          const canvas = originalCreateElement("canvas") as HTMLCanvasElement
          jest.spyOn(canvas, "getContext").mockReturnValue(null)
          return canvas
        }
        return originalCreateElement(tagName)
      })

      const result = generatePlaceholderThumbnail("Icon", "App")

      expect(result).toBe("")

      jest.restoreAllMocks()
    })
  })

  describe("saveThumbnail", () => {
    it("should save thumbnail to localStorage", () => {
      saveThumbnail("app-1", "data:image/png;base64,test")

      const stored = JSON.parse(mockLocalStorage["a2ui-app-thumbnails"])
      expect(stored["app-1"]).toBeDefined()
      expect(stored["app-1"].dataUrl).toBe("data:image/png;base64,test")
    })

    it("should update existing thumbnail", () => {
      saveThumbnail("app-1", "data:image/png;base64,original")
      saveThumbnail("app-1", "data:image/png;base64,updated")

      const stored = JSON.parse(mockLocalStorage["a2ui-app-thumbnails"])
      expect(stored["app-1"].dataUrl).toBe("data:image/png;base64,updated")
    })

    it("should preserve other thumbnails when saving", () => {
      saveThumbnail("app-1", "data:image/png;base64,test1")
      saveThumbnail("app-2", "data:image/png;base64,test2")

      const stored = JSON.parse(mockLocalStorage["a2ui-app-thumbnails"])
      expect(stored["app-1"]).toBeDefined()
      expect(stored["app-2"]).toBeDefined()
    })
  })

  describe("getThumbnail", () => {
    it("should return thumbnail if exists", () => {
      saveThumbnail("app-1", "data:image/png;base64,test")

      const result = getThumbnail("app-1")

      expect(result).toBe("data:image/png;base64,test")
    })

    it("should return null if thumbnail does not exist", () => {
      const result = getThumbnail("non-existent")

      expect(result).toBeNull()
    })
  })

  describe("deleteThumbnail", () => {
    it("should delete thumbnail from storage", () => {
      saveThumbnail("app-1", "data:image/png;base64,test")

      deleteThumbnail("app-1")

      const result = getThumbnail("app-1")
      expect(result).toBeNull()
    })

    it("should not throw if thumbnail does not exist", () => {
      expect(() => deleteThumbnail("non-existent")).not.toThrow()
    })

    it("should preserve other thumbnails when deleting", () => {
      saveThumbnail("app-1", "data:image/png;base64,test1")
      saveThumbnail("app-2", "data:image/png;base64,test2")

      deleteThumbnail("app-1")

      expect(getThumbnail("app-1")).toBeNull()
      expect(getThumbnail("app-2")).toBe("data:image/png;base64,test2")
    })
  })

  describe("isThumbnailStale", () => {
    it("should return true if thumbnail does not exist", () => {
      const result = isThumbnailStale("non-existent", Date.now())

      expect(result).toBe(true)
    })

    it("should return true if app was modified after thumbnail", () => {
      // Save thumbnail at time T
      saveThumbnail("app-1", "data:image/png;base64,test")

      // Check with modification time after thumbnail creation
      const result = isThumbnailStale("app-1", Date.now() + 1000)

      expect(result).toBe(true)
    })

    it("should return false if thumbnail is newer than last modification", () => {
      const modifiedAt = Date.now() - 10000 // 10 seconds ago
      saveThumbnail("app-1", "data:image/png;base64,test")

      const result = isThumbnailStale("app-1", modifiedAt)

      expect(result).toBe(false)
    })
  })

  describe("getAllThumbnails", () => {
    it("should return empty object if no thumbnails", () => {
      const result = getAllThumbnails()

      expect(result).toEqual({})
    })

    it("should return all saved thumbnails", () => {
      saveThumbnail("app-1", "data:image/png;base64,test1")
      saveThumbnail("app-2", "data:image/png;base64,test2")

      const result = getAllThumbnails()

      expect(Object.keys(result)).toHaveLength(2)
      expect(result["app-1"]).toBeDefined()
      expect(result["app-2"]).toBeDefined()
    })
  })

  describe("clearAllThumbnails", () => {
    it("should remove all thumbnails", () => {
      saveThumbnail("app-1", "data:image/png;base64,test1")
      saveThumbnail("app-2", "data:image/png;base64,test2")

      clearAllThumbnails()

      expect(getThumbnail("app-1")).toBeNull()
      expect(getThumbnail("app-2")).toBeNull()
    })
  })

  describe("syncThumbnailsWithApps", () => {
    it("should remove orphaned thumbnails", () => {
      saveThumbnail("app-1", "data:image/png;base64,test1")
      saveThumbnail("app-2", "data:image/png;base64,test2")
      saveThumbnail("app-3", "data:image/png;base64,test3")

      // Only app-1 and app-3 exist
      syncThumbnailsWithApps(["app-1", "app-3"])

      expect(getThumbnail("app-1")).toBe("data:image/png;base64,test1")
      expect(getThumbnail("app-2")).toBeNull()
      expect(getThumbnail("app-3")).toBe("data:image/png;base64,test3")
    })

    it("should handle empty app list", () => {
      saveThumbnail("app-1", "data:image/png;base64,test1")

      syncThumbnailsWithApps([])

      expect(getThumbnail("app-1")).toBeNull()
    })

    it("should not modify if all apps have thumbnails", () => {
      saveThumbnail("app-1", "data:image/png;base64,test1")
      saveThumbnail("app-2", "data:image/png;base64,test2")

      syncThumbnailsWithApps(["app-1", "app-2"])

      expect(getThumbnail("app-1")).toBe("data:image/png;base64,test1")
      expect(getThumbnail("app-2")).toBe("data:image/png;base64,test2")
    })
  })
})

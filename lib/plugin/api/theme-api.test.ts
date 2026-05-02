/**
 * Tests for Theme Plugin API
 */

import { createThemeAPI } from "./theme-api"
import type { CustomTheme } from "@/types/plugin/plugin-extended"

// Mock settings store
let mockTheme = "light"
let mockColorTheme = "default"
let mockActiveCustomThemeId: string | null = null
const mockCustomThemes: CustomTheme[] = []
const mockSubscribers: Array<(state: unknown) => void> = []

jest.mock("@/stores", () => ({
  useSettingsStore: {
    getState: jest.fn(() => ({
      theme: mockTheme,
      colorTheme: mockColorTheme,
      activeCustomThemeId: mockActiveCustomThemeId,
      customThemes: mockCustomThemes,
      setTheme: jest.fn((mode) => {
        mockTheme = mode
        mockSubscribers.forEach((cb) => cb({ theme: mockTheme }))
      }),
      setColorTheme: jest.fn((preset) => {
        mockColorTheme = preset
        mockSubscribers.forEach((cb) => cb({ colorTheme: mockColorTheme }))
      }),
      createCustomTheme: jest.fn((theme) => {
        const id = `custom-${Date.now()}`
        mockCustomThemes.push({ ...theme, id })
        return id
      }),
      updateCustomTheme: jest.fn((id, updates) => {
        const idx = mockCustomThemes.findIndex((t) => t.id === id)
        if (idx >= 0) {
          Object.assign(mockCustomThemes[idx], updates)
        }
      }),
      deleteCustomTheme: jest.fn((id) => {
        const idx = mockCustomThemes.findIndex((t) => t.id === id)
        if (idx >= 0) mockCustomThemes.splice(idx, 1)
      }),
      setActiveCustomTheme: jest.fn((id) => {
        mockActiveCustomThemeId = id
      }),
    })),
    subscribe: jest.fn((callback) => {
      mockSubscribers.push(callback)
      return () => {
        const idx = mockSubscribers.indexOf(callback)
        if (idx >= 0) mockSubscribers.splice(idx, 1)
      }
    }),
  },
}))

jest.mock("@/lib/themes", () => {
  const createColors = (suffix: string) => ({
    primary: `${suffix}-primary`,
    primaryForeground: `${suffix}-primary-foreground`,
    secondary: `${suffix}-secondary`,
    secondaryForeground: `${suffix}-secondary-foreground`,
    accent: `${suffix}-accent`,
    accentForeground: `${suffix}-accent-foreground`,
    background: `${suffix}-background`,
    foreground: `${suffix}-foreground`,
    muted: `${suffix}-muted`,
    mutedForeground: `${suffix}-muted-foreground`,
    card: `${suffix}-card`,
    cardForeground: `${suffix}-card-foreground`,
    border: `${suffix}-border`,
    ring: `${suffix}-ring`,
    destructive: `${suffix}-destructive`,
    destructiveForeground: `${suffix}-destructive-foreground`,
  })

  return {
    resolveActiveThemeColors: jest.fn(
      (input: {
        colorTheme: string
        resolvedTheme: "light" | "dark"
        activeCustomThemeId: string | null
        customThemes: CustomTheme[]
      }) => {
        const activeCustomTheme = input.activeCustomThemeId
          ? (input.customThemes.find((theme) => theme.id === input.activeCustomThemeId) ?? null)
          : null

        if (activeCustomTheme) {
          const customColors = createColors("custom")
          return {
            themeSource: "custom",
            colors: {
              ...customColors,
              ...activeCustomTheme.colors,
            },
            derivedVariables: {},
            activeCustomTheme,
          }
        }

        const suffix = `${input.colorTheme}-${input.resolvedTheme}`
        return {
          themeSource: "preset",
          colors: createColors(suffix),
          derivedVariables: {},
          activeCustomTheme: null,
        }
      }
    ),
  }
})

describe("Theme API", () => {
  const testPluginId = "test-plugin"

  beforeEach(() => {
    mockTheme = "light"
    mockColorTheme = "default"
    mockActiveCustomThemeId = null
    mockCustomThemes.length = 0
    mockSubscribers.length = 0
  })

  describe("createThemeAPI", () => {
    it("should create an API object with all expected methods", () => {
      const api = createThemeAPI(testPluginId)

      expect(api).toBeDefined()
      expect(typeof api.getTheme).toBe("function")
      expect(typeof api.getMode).toBe("function")
      expect(typeof api.getResolvedMode).toBe("function")
      expect(typeof api.setMode).toBe("function")
      expect(typeof api.getColorPreset).toBe("function")
      expect(typeof api.setColorPreset).toBe("function")
      expect(typeof api.getAvailablePresets).toBe("function")
      expect(typeof api.getColors).toBe("function")
      expect(typeof api.registerCustomTheme).toBe("function")
      expect(typeof api.updateCustomTheme).toBe("function")
      expect(typeof api.deleteCustomTheme).toBe("function")
      expect(typeof api.getCustomThemes).toBe("function")
      expect(typeof api.activateCustomTheme).toBe("function")
      expect(typeof api.onThemeChange).toBe("function")
      expect(typeof api.applyScopedColors).toBe("function")
    })
  })

  describe("getTheme", () => {
    it("should return current theme state", () => {
      const api = createThemeAPI(testPluginId)

      const theme = api.getTheme()

      expect(theme.mode).toBe("light")
      expect(theme.resolvedMode).toBe("light")
      expect(theme.colorPreset).toBe("default")
      expect(theme.themeSource).toBe("preset")
      expect(theme.colors).toBeDefined()
    })
  })

  describe("getMode / setMode", () => {
    it("should get current mode", () => {
      const api = createThemeAPI(testPluginId)

      expect(api.getMode()).toBe("light")
    })

    it("should set mode", () => {
      const api = createThemeAPI(testPluginId)

      api.setMode("dark")

      expect(mockTheme).toBe("dark")
    })

    it("should handle system mode", () => {
      mockTheme = "system"
      const api = createThemeAPI(testPluginId)

      expect(api.getMode()).toBe("system")
    })
  })

  describe("getResolvedMode", () => {
    it("should return resolved mode for light", () => {
      mockTheme = "light"
      const api = createThemeAPI(testPluginId)

      expect(api.getResolvedMode()).toBe("light")
    })

    it("should return resolved mode for dark", () => {
      mockTheme = "dark"
      const api = createThemeAPI(testPluginId)

      expect(api.getResolvedMode()).toBe("dark")
    })

    it("should resolve system mode", () => {
      mockTheme = "system"
      const api = createThemeAPI(testPluginId)

      // In test environment without window.matchMedia, should default to light
      const resolved = api.getResolvedMode()
      expect(["light", "dark"]).toContain(resolved)
    })
  })

  describe("getColorPreset / setColorPreset", () => {
    it("should get current color preset", () => {
      const api = createThemeAPI(testPluginId)

      expect(api.getColorPreset()).toBe("default")
    })

    it("should set color preset", () => {
      const api = createThemeAPI(testPluginId)

      api.setColorPreset("ocean")

      expect(mockColorTheme).toBe("ocean")
    })
  })

  describe("getAvailablePresets", () => {
    it("should return all available presets", () => {
      const api = createThemeAPI(testPluginId)

      const presets = api.getAvailablePresets()

      expect(Array.isArray(presets)).toBe(true)
      expect(presets).toContain("default")
      expect(presets).toContain("ocean")
    })
  })

  describe("getColors", () => {
    it("should return current theme colors", () => {
      const api = createThemeAPI(testPluginId)

      const colors = api.getColors()

      expect(colors).toBeDefined()
      expect(colors.primary).toBeDefined()
      expect(colors.background).toBeDefined()
      expect(colors.foreground).toBeDefined()
    })

    it("should return dark colors when in dark mode", () => {
      mockTheme = "dark"
      const api = createThemeAPI(testPluginId)

      const colors = api.getColors()

      expect(colors.background).toBe("default-dark-background")
    })

    it("should return active custom theme colors when custom theme is active", () => {
      mockTheme = "dark"
      mockActiveCustomThemeId = "custom-theme"
      mockCustomThemes.push({
        id: "custom-theme",
        name: "Custom Theme",
        isDark: true,
        colors: {
          primary: "#112233",
          secondary: "#223344",
          accent: "#334455",
          background: "#111111",
          foreground: "#eeeeee",
          muted: "#222222",
        },
      })

      const api = createThemeAPI(testPluginId)
      const theme = api.getTheme()

      expect(theme.themeSource).toBe("custom")
      expect(theme.colors.primary).toBe("#112233")
      expect(theme.customThemeId).toBe("custom-theme")
    })
  })

  describe("Custom theme management", () => {
    it("should register a custom theme", () => {
      const api = createThemeAPI(testPluginId)

      const id = api.registerCustomTheme({
        name: "My Theme",
        isDark: false,
        colors: {
          primary: "#3b82f6",
          secondary: "#64748b",
          accent: "#3b82f6",
          background: "#ffffff",
          foreground: "#0f172a",
          muted: "#f1f5f9",
        },
      })

      expect(id).toBeDefined()
      expect(mockCustomThemes.length).toBe(1)
      expect(mockCustomThemes[0].name).toBe("My Theme")
    })

    it("should update a custom theme", () => {
      mockCustomThemes.push({
        id: "update-theme",
        name: "Original",
        isDark: false,
        colors: {
          primary: "#000",
          secondary: "#000",
          accent: "#000",
          background: "#fff",
          foreground: "#000",
          muted: "#ccc",
        },
      })

      const api = createThemeAPI(testPluginId)
      api.updateCustomTheme("update-theme", { name: "Updated" })

      expect(mockCustomThemes[0].name).toBe("Updated")
    })

    it("should delete a custom theme", () => {
      mockCustomThemes.push({
        id: "delete-theme",
        name: "To Delete",
        isDark: false,
        colors: {
          primary: "#000",
          secondary: "#000",
          accent: "#000",
          background: "#fff",
          foreground: "#000",
          muted: "#ccc",
        },
      })

      const api = createThemeAPI(testPluginId)
      api.deleteCustomTheme("delete-theme")

      expect(mockCustomThemes.length).toBe(0)
    })

    it("should get all custom themes", () => {
      mockCustomThemes.push(
        {
          id: "t1",
          name: "Theme 1",
          isDark: false,
          colors: {
            primary: "#000",
            secondary: "#000",
            accent: "#000",
            background: "#fff",
            foreground: "#000",
            muted: "#ccc",
          },
        },
        {
          id: "t2",
          name: "Theme 2",
          isDark: true,
          colors: {
            primary: "#fff",
            secondary: "#fff",
            accent: "#fff",
            background: "#000",
            foreground: "#fff",
            muted: "#333",
          },
        }
      )

      const api = createThemeAPI(testPluginId)
      const themes = api.getCustomThemes()

      expect(themes.length).toBe(2)
    })

    it("should activate a custom theme", () => {
      const api = createThemeAPI(testPluginId)
      api.activateCustomTheme("custom-theme-id")

      expect(mockActiveCustomThemeId).toBe("custom-theme-id")
    })
  })

  describe("onThemeChange", () => {
    it("should subscribe to theme changes", () => {
      const api = createThemeAPI(testPluginId)
      const handler = jest.fn()

      const unsubscribe = api.onThemeChange(handler)

      expect(typeof unsubscribe).toBe("function")
      expect(mockSubscribers.length).toBe(1)
    })

    it("should unsubscribe when cleanup is called", () => {
      const api = createThemeAPI(testPluginId)
      const handler = jest.fn()

      const unsubscribe = api.onThemeChange(handler)
      expect(mockSubscribers.length).toBe(1)

      unsubscribe()
      expect(mockSubscribers.length).toBe(0)
    })

    it("emits changes when active custom theme colors are updated", () => {
      mockActiveCustomThemeId = "custom-theme"
      mockCustomThemes.push({
        id: "custom-theme",
        name: "Custom",
        isDark: false,
        colors: {
          primary: "#000000",
          secondary: "#111111",
          accent: "#222222",
          background: "#ffffff",
          foreground: "#000000",
          muted: "#f1f5f9",
        },
      })

      const api = createThemeAPI(testPluginId)
      const handler = jest.fn()
      const unsubscribe = api.onThemeChange(handler)

      mockCustomThemes[0].colors.primary = "#123456"
      mockSubscribers.forEach((callback) =>
        callback({
          theme: mockTheme,
          colorTheme: mockColorTheme,
          activeCustomThemeId: mockActiveCustomThemeId,
          customThemes: mockCustomThemes,
        })
      )

      expect(handler).toHaveBeenCalled()
      const payload = handler.mock.calls[0][0]
      expect(payload.themeSource).toBe("custom")
      expect(payload.colors.primary).toBe("#123456")

      unsubscribe()
    })
  })

  describe("applyScopedColors", () => {
    it("should apply scoped colors to element", () => {
      const api = createThemeAPI(testPluginId)

      const mockElement = {
        style: {
          getPropertyValue: jest.fn(() => ""),
          setProperty: jest.fn(),
          removeProperty: jest.fn(),
        },
      } as unknown as HTMLElement

      const cleanup = api.applyScopedColors(mockElement, {
        primary: "#ff0000",
        background: "#ffffff",
      })

      expect(mockElement.style.setProperty).toHaveBeenCalled()
      expect(typeof cleanup).toBe("function")
    })

    it("should restore original styles on cleanup", () => {
      const api = createThemeAPI(testPluginId)

      const mockElement = {
        style: {
          getPropertyValue: jest.fn(() => "original-value"),
          setProperty: jest.fn(),
          removeProperty: jest.fn(),
        },
      } as unknown as HTMLElement

      const cleanup = api.applyScopedColors(mockElement, {
        primary: "#ff0000",
      })

      cleanup()

      // Should restore original value
      expect(mockElement.style.setProperty).toHaveBeenCalledWith(
        expect.any(String),
        "original-value"
      )
    })
  })
})

/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

// usePluginStore is a Zustand store; we stub it to a selector-aware fake
// so we can drive arbitrary `s.plugins[id]` shapes without booting the
// real store + manager.
type Plugin = {
  id: string
  source: string
  manifest: { name?: string; icon?: string; updateAvailable?: boolean }
}

let pluginsState: Record<string, Plugin> = {}

jest.mock("@/stores/plugin/plugin-store", () => ({
  usePluginStore: <T>(selector: (s: { plugins: Record<string, Plugin> }) => T) =>
    selector({ plugins: pluginsState }),
}))

import { usePluginMetadata } from "./use-plugin-metadata"

beforeEach(() => {
  pluginsState = {}
})

describe("usePluginMetadata", () => {
  it("returns undefined when pluginId is undefined or null", () => {
    pluginsState = {
      p1: {
        id: "p1",
        source: "marketplace",
        manifest: { name: "P1" },
      },
    }
    const { result: r1 } = renderHook(() => usePluginMetadata(undefined))
    const { result: r2 } = renderHook(() => usePluginMetadata(null))
    expect(r1.current).toBeUndefined()
    expect(r2.current).toBeUndefined()
  })

  it("returns undefined when the plugin id is not in the store", () => {
    const { result } = renderHook(() => usePluginMetadata("nope"))
    expect(result.current).toBeUndefined()
  })

  it("projects manifest name / icon / source into the metadata shape", () => {
    pluginsState = {
      "plug-a": {
        id: "plug-a",
        source: "marketplace",
        manifest: { name: "Plug A", icon: "lucide:rocket" },
      },
    }
    const { result } = renderHook(() => usePluginMetadata("plug-a"))
    expect(result.current).toEqual({
      id: "plug-a",
      name: "Plug A",
      icon: "lucide:rocket",
      source: "marketplace",
      updateAvailable: false,
    })
  })

  it("falls back to the pluginId when the manifest carries no name", () => {
    pluginsState = {
      "plug-b": {
        id: "plug-b",
        source: "local",
        manifest: {},
      },
    }
    const { result } = renderHook(() => usePluginMetadata("plug-b"))
    expect(result.current?.name).toBe("plug-b")
  })

  it("surfaces updateAvailable when the manifest sets the flag", () => {
    pluginsState = {
      "plug-c": {
        id: "plug-c",
        source: "marketplace",
        manifest: { name: "Plug C", updateAvailable: true },
      },
    }
    const { result } = renderHook(() => usePluginMetadata("plug-c"))
    expect(result.current?.updateAvailable).toBe(true)
  })
})

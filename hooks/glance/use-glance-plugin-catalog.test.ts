/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"

import { glancePluginModules } from "@/lib/glance/plugin-registry"

import { useGlancePluginCatalog } from "./use-glance-plugin-catalog"

const PLUGIN = "test.catalog"

afterEach(() => {
  glancePluginModules.unregisterAllByPlugin(PLUGIN)
})

describe("useGlancePluginCatalog", () => {
  it("lists the running plugin modules of a platform and follows changes", () => {
    glancePluginModules.register(PLUGIN, { id: "a", title: "Alpha", platforms: ["desktop"] })
    const desktop = renderHook(() => useGlancePluginCatalog("desktop"))
    const mobile = renderHook(() => useGlancePluginCatalog("mobile"))
    expect(desktop.result.current.map((c) => [c.id, c.title])).toEqual([
      [`plugin:${PLUGIN}:a`, "Alpha"],
    ])
    expect(mobile.result.current).toEqual([])

    act(() => {
      glancePluginModules.register(PLUGIN, { id: "b", title: "Beta" })
    })
    expect(desktop.result.current.map((c) => c.id)).toEqual([
      `plugin:${PLUGIN}:a`,
      `plugin:${PLUGIN}:b`,
    ])
    expect(mobile.result.current.map((c) => c.id)).toEqual([`plugin:${PLUGIN}:b`])

    act(() => {
      glancePluginModules.unregisterAllByPlugin(PLUGIN)
    })
    expect(desktop.result.current).toEqual([])
  })

  it("keeps its identity while nothing changes", () => {
    glancePluginModules.register(PLUGIN, { id: "a", title: "Alpha" })
    const { result, rerender } = renderHook(() => useGlancePluginCatalog("desktop"))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})

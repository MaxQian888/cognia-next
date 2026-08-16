/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"

import { usePresetCatalog } from "./use-preset-catalog"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"

function customMode(id: string, name = `Mode ${id}`) {
  return {
    id,
    type: "custom",
    name,
    description: `Description for ${id}`,
    icon: "Sparkles",
    isBuiltIn: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }
}

function pluginRow(id: string, status: "enabled" | "disabled", modeId: string) {
  return {
    id,
    status,
    modes: [
      {
        id: modeId,
        type: "custom",
        name: `Plugin mode ${modeId}`,
        description: "From a plugin",
        icon: "Puzzle",
      },
    ],
  }
}

describe("usePresetCatalog", () => {
  beforeEach(() => {
    useCustomModeStore.setState({ customModes: {} })
    usePluginStore.setState({ plugins: {} } as never)
  })

  // Wrapped in `act` because a mounted hook is still subscribed here: an
  // unwrapped reset re-renders it and React 19 warns.
  afterEach(() => {
    act(() => {
      useCustomModeStore.setState({ customModes: {} })
      usePluginStore.setState({ plugins: {} } as never)
    })
  })

  it("includes the built-in presets with neither store populated", () => {
    const { result } = renderHook(() => usePresetCatalog())
    const ids = result.current.map((p) => p.id)

    expect(ids).toContain("standard")
    expect(ids).toContain("minimal")
  })

  // The defect this hook exists for: the sheet used `useMemo(…, [])`, so a mode
  // authored while the sheet was open never showed up.
  it("re-renders with a custom mode created after mount", () => {
    const { result } = renderHook(() => usePresetCatalog())
    expect(result.current.map((p) => p.id)).not.toContain("my-reviewer")

    act(() => {
      useCustomModeStore.setState({
        customModes: { "my-reviewer": customMode("my-reviewer") } as never,
      })
    })

    const preset = result.current.find((p) => p.id === "my-reviewer")
    expect(preset?.source).toBe("custom")
    expect(preset?.name).toBe("Mode my-reviewer")
  })

  it("drops a custom mode again once it is deleted", () => {
    useCustomModeStore.setState({
      customModes: { doomed: customMode("doomed") } as never,
    })
    const { result } = renderHook(() => usePresetCatalog())
    expect(result.current.map((p) => p.id)).toContain("doomed")

    act(() => useCustomModeStore.setState({ customModes: {} }))

    expect(result.current.map((p) => p.id)).not.toContain("doomed")
  })

  it("offers modes from enabled plugins and hides disabled ones", () => {
    usePluginStore.setState({
      plugins: {
        on: pluginRow("on", "enabled", "live-mode"),
        off: pluginRow("off", "disabled", "dormant-mode"),
      },
    } as never)

    const { result } = renderHook(() => usePresetCatalog())
    const ids = result.current.map((p) => p.id)

    expect(ids).toContain("live-mode")
    expect(ids).not.toContain("dormant-mode")
    expect(result.current.find((p) => p.id === "live-mode")?.source).toBe("plugin")
  })

  // Most plugins contribute no modes at all; the field is optional, and reading
  // it without a guard would throw on every install that ships only tools.
  it("tolerates an enabled plugin that contributes no modes", () => {
    usePluginStore.setState({
      plugins: { toolsOnly: { id: "toolsOnly", status: "enabled" } },
    } as never)

    const { result } = renderHook(() => usePresetCatalog())

    expect(result.current.map((p) => p.id)).toContain("standard")
  })

  it("picks up a plugin mode when the plugin is enabled after mount", () => {
    usePluginStore.setState({
      plugins: { later: pluginRow("later", "disabled", "late-mode") },
    } as never)
    const { result } = renderHook(() => usePresetCatalog())
    expect(result.current.map((p) => p.id)).not.toContain("late-mode")

    act(() => {
      usePluginStore.setState({
        plugins: { later: pluginRow("later", "enabled", "late-mode") },
      } as never)
    })

    expect(result.current.map((p) => p.id)).toContain("late-mode")
  })
})

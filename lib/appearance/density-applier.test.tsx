import { render } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings"
import { DensityApplier, resolveDensityAttrs, densitySurfaceProps } from "./density-applier"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"
import type { DensitySettings } from "@/types/appearance"

const baseSettings = {
  id: "singleton" as const,
  permissionMode: "default" as const,
  alwaysAllowTools: [],
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
}

function setSettings(density: DensitySettings | undefined) {
  useSettingsStore.setState({
    settings: density ? { ...baseSettings, density } : { ...baseSettings },
  })
}

afterEach(() => {
  document.documentElement.removeAttribute("data-density")
  document.documentElement.removeAttribute("data-density-chat")
  document.documentElement.removeAttribute("data-density-table")
  document.documentElement.removeAttribute("data-density-sidebar")
  useSettingsStore.setState({ settings: null })
})

describe("resolveDensityAttrs", () => {
  it("emits data-density='comfortable' by default", () => {
    expect(resolveDensityAttrs(undefined)).toEqual({
      "data-density": "comfortable",
      "data-density-chat": null,
      "data-density-table": null,
      "data-density-sidebar": null,
    })
  })

  it("emits a surface override only when it differs from the global", () => {
    expect(
      resolveDensityAttrs({ global: "comfortable", chat: "comfortable", table: "spacious" })
    ).toEqual({
      "data-density": "comfortable",
      "data-density-chat": null,
      "data-density-table": "spacious",
      "data-density-sidebar": null,
    })
  })

  it("reflects the global level across the board", () => {
    expect(resolveDensityAttrs({ global: "compact" })).toMatchObject({
      "data-density": "compact",
    })
  })
})

describe("DensityApplier", () => {
  it("writes data-density on mount and removes it on unmount", () => {
    setSettings({ global: "compact", chat: "spacious" })
    const root = document.documentElement
    const { unmount } = render(<DensityApplier />)
    expect(root.getAttribute("data-density")).toBe("compact")
    expect(root.getAttribute("data-density-chat")).toBe("spacious")
    expect(root.hasAttribute("data-density-table")).toBe(false)
    unmount()
    expect(root.hasAttribute("data-density")).toBe(false)
    expect(root.hasAttribute("data-density-chat")).toBe(false)
  })

  it("falls back to comfortable when settings are absent", () => {
    setSettings(undefined)
    render(<DensityApplier />)
    expect(document.documentElement.getAttribute("data-density")).toBe("comfortable")
  })
})

describe("densitySurfaceProps", () => {
  it("returns only data-surface when no override differs from global", () => {
    expect(densitySurfaceProps("chat", { global: "comfortable" })).toEqual({
      "data-surface": "chat",
    })
  })

  it("includes data-density-surface only when the surface override differs", () => {
    expect(densitySurfaceProps("table", { global: "comfortable", table: "compact" })).toEqual({
      "data-surface": "table",
      "data-density-surface": "compact",
    })
  })
})

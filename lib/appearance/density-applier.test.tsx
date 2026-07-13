import { render } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings"
import {
  DensityApplier,
  resolveDensityAttrs,
  densitySurfaceProps,
  applyDensityPresetVars,
  clearDensityPresetVars,
} from "./density-applier"
import {
  registerDensityPresetsForPlugin,
  __resetDensityPresetRegistryForTesting,
} from "./density-preset-registry"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
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

describe("applyDensityPresetVars / clearDensityPresetVars", () => {
  afterEach(() => {
    __resetDensityPresetRegistryForTesting()
    clearDensityPresetVars()
  })

  it("injects a registered preset's vars onto <html> and returns true", () => {
    registerDensityPresetsForPlugin("p1", [
      { name: "cozy", vars: { "--density-spacing": "0.5rem", "--density-gap": "0.75rem" } },
    ])
    expect(applyDensityPresetVars("cozy")).toBe(true)
    const root = document.documentElement
    expect(root.style.getPropertyValue("--density-spacing")).toBe("0.5rem")
    expect(root.style.getPropertyValue("--density-gap")).toBe("0.75rem")
  })

  it("returns false and injects nothing for an unknown preset", () => {
    expect(applyDensityPresetVars("nope")).toBe(false)
    expect(document.documentElement.style.getPropertyValue("--density-spacing")).toBe("")
  })

  it("clearDensityPresetVars removes previously injected overrides", () => {
    registerDensityPresetsForPlugin("p1", [
      { name: "cozy", vars: { "--density-spacing": "0.5rem" } },
    ])
    applyDensityPresetVars("cozy")
    clearDensityPresetVars()
    expect(document.documentElement.style.getPropertyValue("--density-spacing")).toBe("")
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

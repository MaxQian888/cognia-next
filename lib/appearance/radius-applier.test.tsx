import { render } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings"
import { RadiusApplier, resolveRadiusVar } from "./radius-applier"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"
import type { RadiusSettings } from "@/types/appearance"

const baseSettings = {
  id: "singleton" as const,
  permissionMode: "default" as const,
  alwaysAllowTools: [],
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
}

function setRadius(radius: RadiusSettings | undefined) {
  useSettingsStore.setState({
    settings: radius ? { ...baseSettings, radius } : { ...baseSettings },
  })
}

afterEach(() => {
  document.documentElement.style.removeProperty("--radius")
  useSettingsStore.setState({ settings: null })
})

describe("resolveRadiusVar", () => {
  it("returns null at default radius so stylesheet wins", () => {
    expect(resolveRadiusVar(undefined)).toBeNull()
    expect(resolveRadiusVar({ base: 0.625 })).toBeNull()
  })

  it("returns rem string for non-default values", () => {
    expect(resolveRadiusVar({ base: 1 })).toBe("1rem")
    expect(resolveRadiusVar({ base: 0 })).toBe("0rem")
  })

  it("clamps to 0..1.5 rem", () => {
    expect(resolveRadiusVar({ base: -1 })).toBe("0rem")
    expect(resolveRadiusVar({ base: 5 })).toBe("1.5rem")
  })

  it("treats non-finite values as null", () => {
    expect(resolveRadiusVar({ base: Number.NaN })).toBeNull()
  })
})

describe("RadiusApplier", () => {
  it("writes --radius onto <html> when value differs from default", () => {
    setRadius({ base: 0.25 })
    const { unmount } = render(<RadiusApplier />)
    expect(document.documentElement.style.getPropertyValue("--radius")).toBe("0.25rem")
    unmount()
    expect(document.documentElement.style.getPropertyValue("--radius")).toBe("")
  })

  it("does not write --radius when value matches default", () => {
    document.documentElement.style.setProperty("--radius", "1rem") // simulate prior write
    setRadius({ base: 0.625 })
    render(<RadiusApplier />)
    // Default branch removes any prior inline write so the stylesheet rule
    // remains the source of truth.
    expect(document.documentElement.style.getPropertyValue("--radius")).toBe("")
  })
})

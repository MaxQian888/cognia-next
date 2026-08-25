import { act, render } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
import type { StylePackSettings } from "@/types/appearance/style-pack"
import { StylePackApplier, resolveStylePackDom } from "./style-pack-applier"

const baseSettings = {
  id: "singleton" as const,
  permissionMode: "default" as const,
  alwaysAllowTools: [],
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
}

const OWNED_ATTRS = [
  "data-style-pack",
  "data-border-tone",
  "data-elevation-max",
  "data-micro-label",
] as const
const OWNED_VARS = ["--pill-radius", "--style-letter-spacing-em"] as const

function setStylePack(stylePack: StylePackSettings | undefined) {
  useSettingsStore.setState({
    settings: stylePack ? { ...baseSettings, stylePack } : { ...baseSettings },
  })
}

afterEach(() => {
  for (const attr of OWNED_ATTRS) document.documentElement.removeAttribute(attr)
  for (const name of OWNED_VARS) document.documentElement.style.removeProperty(name)
  useSettingsStore.setState({ settings: null })
})

describe("resolveStylePackDom", () => {
  /**
   * The load-bearing guarantee: Soft is inert. If this ever returns a non-null
   * value the default look stops being unchanged-by-construction and becomes a
   * promise that some rem→px conversion was done right.
   */
  it("writes nothing at all for the soft pack", () => {
    for (const settings of [undefined, { packId: "soft" } as StylePackSettings]) {
      const dom = resolveStylePackDom(settings)
      expect(Object.values(dom.vars).every((v) => v === null)).toBe(true)
      expect(Object.values(dom.attrs).every((v) => v === null)).toBe(true)
    }
  })

  it("squares pills and drops shadows under sharp", () => {
    const dom = resolveStylePackDom({ packId: "sharp" })
    expect(dom.vars["--pill-radius"]).toBe("0px")
    expect(dom.attrs["data-elevation-max"]).toBe("0")
    expect(dom.attrs["data-micro-label"]).toBe("mono-upper")
    expect(dom.attrs["data-border-tone"]).toBe("strong")
    expect(dom.attrs["data-style-pack"]).toBe("sharp")
  })

  it("shrinks pills without squaring them under studio", () => {
    const dom = resolveStylePackDom({ packId: "studio" })
    expect(dom.vars["--pill-radius"]).toBe("8px")
    expect(dom.attrs["data-elevation-max"]).toBe("1")
    expect(dom.attrs["data-border-tone"]).toBe("hairline")
    // Studio is not a monospace look — only Sharp is.
    expect(dom.attrs["data-micro-label"]).toBeNull()
  })

  it("omits a var whose value already matches the stylesheet", () => {
    // Studio does not tighten tracking, so the letter-spacing var stays unset
    // and the user's own typography slider keeps sole ownership of it.
    expect(resolveStylePackDom({ packId: "studio" }).vars["--style-letter-spacing-em"]).toBeNull()
    expect(resolveStylePackDom({ packId: "sharp" }).vars["--style-letter-spacing-em"]).toBe(
      "-0.005em"
    )
  })
})

describe("StylePackApplier", () => {
  it("touches no attribute or property under the default pack", () => {
    setStylePack(undefined)
    render(<StylePackApplier />)
    for (const attr of OWNED_ATTRS) {
      expect(document.documentElement.hasAttribute(attr)).toBe(false)
    }
    for (const name of OWNED_VARS) {
      expect(document.documentElement.style.getPropertyValue(name)).toBe("")
    }
  })

  it("reflects a non-default pack onto <html>", () => {
    setStylePack({ packId: "sharp" })
    render(<StylePackApplier />)
    const root = document.documentElement
    expect(root.getAttribute("data-style-pack")).toBe("sharp")
    expect(root.getAttribute("data-elevation-max")).toBe("0")
    expect(root.style.getPropertyValue("--pill-radius")).toBe("0px")
  })

  it("clears everything it wrote on unmount", () => {
    setStylePack({ packId: "sharp" })
    const view = render(<StylePackApplier />)
    view.unmount()
    for (const attr of OWNED_ATTRS) {
      expect(document.documentElement.hasAttribute(attr)).toBe(false)
    }
    expect(document.documentElement.style.getPropertyValue("--pill-radius")).toBe("")
  })

  it("drops stale attributes when switching back to soft", () => {
    setStylePack({ packId: "sharp" })
    const view = render(<StylePackApplier />)
    expect(document.documentElement.getAttribute("data-style-pack")).toBe("sharp")

    act(() => setStylePack({ packId: "soft" }))
    view.rerender(<StylePackApplier />)
    expect(document.documentElement.hasAttribute("data-style-pack")).toBe(false)
    expect(document.documentElement.style.getPropertyValue("--pill-radius")).toBe("")
  })
})

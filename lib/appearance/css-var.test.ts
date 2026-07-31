/** @jest-environment jsdom */
import {
  themeKeyToCssVar,
  CSS_VAR_KEYS,
  applyCssVars,
  removeCssVars,
  setDataAttr,
  applyDataAttrs,
  removeDataAttrs,
} from "./css-var"
import { THEME_COLOR_KEYS } from "./vscode-theme/token-mapping"

describe("themeKeyToCssVar", () => {
  it.each([
    ["background", "--background"],
    ["primaryForeground", "--primary-foreground"],
    ["sidebarPrimary", "--sidebar-primary"],
    ["sidebarPrimaryForeground", "--sidebar-primary-foreground"],
    ["popoverForeground", "--popover-foreground"],
  ])("converts %s -> %s", (input, expected) => {
    expect(themeKeyToCssVar(input)).toBe(expected)
  })

  it("does not produce a triple-dash for PascalCase", () => {
    expect(themeKeyToCssVar("Primary")).toBe("--primary")
  })
})

describe("CSS_VAR_KEYS", () => {
  it("covers every ThemeColors key", () => {
    expect(CSS_VAR_KEYS.length).toBe(THEME_COLOR_KEYS.length)
  })
  it("every entry starts with --", () => {
    for (const v of CSS_VAR_KEYS) {
      expect(v.startsWith("--")).toBe(true)
    }
  })
})

describe("applyCssVars", () => {
  function el(): HTMLElement {
    return document.createElement("div")
  }

  it("writes every defined value and returns the keys written", () => {
    const target = el()
    const written = applyCssVars(target, {
      "--density-spacing": "0.75",
      "--motion-duration-scale": 1.5,
    })
    expect(written.sort()).toEqual(["--density-spacing", "--motion-duration-scale"])
    expect(target.style.getPropertyValue("--density-spacing")).toBe("0.75")
    expect(target.style.getPropertyValue("--motion-duration-scale")).toBe("1.5")
  })

  it("skips undefined, null, and empty-string values", () => {
    const target = el()
    const written = applyCssVars(target, {
      "--a": "1",
      "--b": undefined,
      "--c": null,
      "--d": "",
    })
    expect(written).toEqual(["--a"])
    expect(target.style.getPropertyValue("--a")).toBe("1")
    expect(target.style.getPropertyValue("--b")).toBe("")
    expect(target.style.getPropertyValue("--c")).toBe("")
    expect(target.style.getPropertyValue("--d")).toBe("")
  })

  it("coerces numeric values to strings", () => {
    const target = el()
    applyCssVars(target, { "--scale": 0.5 })
    expect(target.style.getPropertyValue("--scale")).toBe("0.5")
  })
})

describe("removeCssVars", () => {
  it("clears each named property", () => {
    const target = document.createElement("div")
    target.style.setProperty("--a", "1")
    target.style.setProperty("--b", "2")
    removeCssVars(target, ["--a", "--b", "--never-set"])
    expect(target.style.getPropertyValue("--a")).toBe("")
    expect(target.style.getPropertyValue("--b")).toBe("")
  })
})

describe("setDataAttr", () => {
  it("sets when value is non-empty and returns true", () => {
    const target = document.createElement("div")
    expect(setDataAttr(target, "data-density", "compact")).toBe(true)
    expect(target.getAttribute("data-density")).toBe("compact")
  })

  it.each([null, undefined, ""] as const)("removes the attribute when value is %p", (value) => {
    const target = document.createElement("div")
    target.setAttribute("data-density", "comfortable")
    expect(setDataAttr(target, "data-density", value)).toBe(false)
    expect(target.hasAttribute("data-density")).toBe(false)
  })
})

describe("applyDataAttrs / removeDataAttrs", () => {
  it("apply returns the names actually written and remove clears them", () => {
    const target = document.createElement("div")
    const names = applyDataAttrs(target, {
      "data-density": "compact",
      "data-surface": "chat",
      "data-empty": "",
    })
    expect(names.sort()).toEqual(["data-density", "data-surface"])
    expect(target.getAttribute("data-density")).toBe("compact")
    expect(target.getAttribute("data-surface")).toBe("chat")
    expect(target.hasAttribute("data-empty")).toBe(false)

    removeDataAttrs(target, names)
    expect(target.hasAttribute("data-density")).toBe(false)
    expect(target.hasAttribute("data-surface")).toBe(false)
  })
})

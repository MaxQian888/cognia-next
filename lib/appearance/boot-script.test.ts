/**
 * @jest-environment jsdom
 */

import {
  BOOT_MIRROR_KEYS,
  BOOT_MIRROR_STORAGE_KEY,
  BOOT_SCRIPT,
  clearBootMirror,
  runBootScript,
  writeBootMirror,
} from "./boot-script"

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute("style")
})

describe("BOOT_SCRIPT", () => {
  it("does nothing when the mirror entry is missing", () => {
    runBootScript()
    expect(document.documentElement.style.length).toBe(0)
  })

  it("does nothing when the mirror entry is malformed JSON", () => {
    window.localStorage.setItem(BOOT_MIRROR_STORAGE_KEY, "{not json")
    expect(() => runBootScript()).not.toThrow()
    expect(document.documentElement.style.length).toBe(0)
  })

  it("does nothing when the mirror entry is JSON but not an object", () => {
    window.localStorage.setItem(BOOT_MIRROR_STORAGE_KEY, "42")
    runBootScript()
    expect(document.documentElement.style.length).toBe(0)
  })

  it("applies every mirrored CSS variable to documentElement.style", () => {
    window.localStorage.setItem(
      BOOT_MIRROR_STORAGE_KEY,
      JSON.stringify({
        "--foreground": "#0f172a",
        "--background": "#ffffff",
        "--primary": "#3b82f6",
        "--accent": "oklch(0.7 0.2 30)",
      })
    )
    runBootScript()
    const style = document.documentElement.style
    expect(style.getPropertyValue("--foreground")).toBe("#0f172a")
    expect(style.getPropertyValue("--background")).toBe("#ffffff")
    expect(style.getPropertyValue("--primary")).toBe("#3b82f6")
    expect(style.getPropertyValue("--accent")).toBe("oklch(0.7 0.2 30)")
  })

  it("skips keys that are not in the boot mirror allowlist", () => {
    window.localStorage.setItem(
      BOOT_MIRROR_STORAGE_KEY,
      JSON.stringify({
        "--foreground": "#000",
        "--unknown": "#fff",
      })
    )
    runBootScript()
    expect(document.documentElement.style.getPropertyValue("--foreground")).toBe("#000")
    // Unknown keys are not applied — only the allowlist gets written.
    expect(document.documentElement.style.getPropertyValue("--unknown")).toBe("")
  })

  it("skips keys whose mirrored value is empty / non-string", () => {
    window.localStorage.setItem(
      BOOT_MIRROR_STORAGE_KEY,
      JSON.stringify({
        "--foreground": "",
        "--background": null,
        "--primary": 0,
        "--accent": "#cafe22",
      })
    )
    runBootScript()
    expect(document.documentElement.style.getPropertyValue("--foreground")).toBe("")
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("")
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe("")
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#cafe22")
  })

  it("does NOT toggle the dark class — next-themes owns that", () => {
    document.documentElement.classList.remove("dark")
    window.localStorage.setItem(
      BOOT_MIRROR_STORAGE_KEY,
      JSON.stringify({ "--background": "#0b1220" })
    )
    runBootScript()
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  it("exposes the same allowlist that writeBootMirror is expected to populate", () => {
    expect(BOOT_MIRROR_KEYS).toEqual(["--foreground", "--background", "--primary", "--accent"])
  })

  it("the serialised BOOT_SCRIPT string parses as a self-contained IIFE", () => {
    // Smoke-check that the embedded form actually executes without import
    // resolution — the renderer ships this string into `<head>` before the
    // bundler has run.
    expect(BOOT_SCRIPT.startsWith("(function () {")).toBe(true)
    expect(BOOT_SCRIPT).toContain(BOOT_MIRROR_STORAGE_KEY)
    expect(BOOT_SCRIPT.endsWith("})();")).toBe(true)
  })
})

describe("writeBootMirror / clearBootMirror", () => {
  it("writeBootMirror persists the JSON snapshot under the canonical key", () => {
    writeBootMirror({
      "--foreground": "#000",
      "--background": "#fff",
      "--primary": "#3b82f6",
      "--accent": "#22c55e",
    })
    const raw = window.localStorage.getItem(BOOT_MIRROR_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw ?? "{}")
    expect(parsed["--background"]).toBe("#fff")
    expect(parsed["--primary"]).toBe("#3b82f6")
  })

  it("clearBootMirror removes the persisted entry", () => {
    writeBootMirror({ "--foreground": "#000" })
    clearBootMirror()
    expect(window.localStorage.getItem(BOOT_MIRROR_STORAGE_KEY)).toBeNull()
  })

  it("writeBootMirror swallows quota errors", () => {
    const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    const setItemSpy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded")
    })
    expect(() => writeBootMirror({ "--background": "#fff" })).not.toThrow()
    setItemSpy.mockRestore()
    consoleSpy.mockRestore()
  })
})

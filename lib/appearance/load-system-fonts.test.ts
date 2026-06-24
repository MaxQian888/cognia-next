/**
 * @jest-environment node
 */

import { loadSystemFonts, __resetLoadSystemFontsForTesting } from "./load-system-fonts"
import { listFonts, __resetFontRegistryForTesting, type FontEntry } from "./font-registry"

function systemEntries(): FontEntry[] {
  return listFonts().filter((f) => f.source === "system")
}

beforeEach(() => {
  __resetFontRegistryForTesting()
  __resetLoadSystemFontsForTesting()
})

describe("loadSystemFonts", () => {
  it("is a no-op on web (non-desktop)", async () => {
    const invoke = jest.fn()
    await loadSystemFonts({ isDesktop: () => false, invoke })
    expect(invoke).not.toHaveBeenCalled()
    expect(systemEntries()).toHaveLength(0)
  })

  it("invokes os_list_fonts and pushes the result into the registry", async () => {
    const invoke = jest.fn(async () => [
      { family: "JetBrains Mono", monospaced: true },
      { family: "Helvetica Neue", monospaced: false },
    ])
    await loadSystemFonts({ isDesktop: () => true, invoke })
    expect(invoke).toHaveBeenCalledWith("os_list_fonts")
    const fonts = systemEntries()
    expect(fonts.map((f) => f.family)).toEqual(["Helvetica Neue", "JetBrains Mono"])
    expect(fonts.find((f) => f.family === "JetBrains Mono")?.monospaced).toBe(true)
    expect(fonts.find((f) => f.family === "Helvetica Neue")?.monospaced).toBe(false)
  })

  it("only hits the backend once per session", async () => {
    const invoke = jest.fn(async () => [{ family: "Menlo", monospaced: true }])
    await loadSystemFonts({ isDesktop: () => true, invoke })
    await loadSystemFonts({ isDesktop: () => true, invoke })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it("swallows backend errors and allows a later retry", async () => {
    const failing = jest.fn(async () => {
      throw new Error("command unavailable")
    })
    await loadSystemFonts({ isDesktop: () => true, invoke: failing })
    expect(systemEntries()).toHaveLength(0)

    // The once-guard was released, so a subsequent call can succeed.
    const ok = jest.fn(async () => [{ family: "Fira Code", monospaced: true }])
    await loadSystemFonts({ isDesktop: () => true, invoke: ok })
    expect(systemEntries().map((f) => f.family)).toEqual(["Fira Code"])
  })
})

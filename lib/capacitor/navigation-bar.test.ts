/**
 * @jest-environment jsdom
 */
import { setNavigationBarColor, syncWithTheme } from "./navigation-bar"

function makeNb() {
  return {
    setNavigationBarColor: jest.fn().mockResolvedValue(undefined),
  }
}

describe("navigation-bar wrapper", () => {
  it("setNavigationBarColor forwards the hex color with dark buttons by default", async () => {
    const nb = makeNb()
    const out = await setNavigationBarColor("#abcdef", undefined, async () => nb)
    expect(out).toEqual({ kind: "ok" })
    expect(nb.setNavigationBarColor).toHaveBeenCalledWith({ color: "#abcdef", darkButtons: true })
  })

  it("setNavigationBarColor forwards darkButtons=false for dark bars", async () => {
    const nb = makeNb()
    await setNavigationBarColor("#000000", false, async () => nb)
    expect(nb.setNavigationBarColor).toHaveBeenCalledWith({ color: "#000000", darkButtons: false })
  })

  it("syncWithTheme picks the dark hex + light icons when resolved theme is dark", async () => {
    const nb = makeNb()
    await syncWithTheme("dark", undefined, async () => nb)
    expect(nb.setNavigationBarColor).toHaveBeenCalledWith({
      color: "#0a0a0a",
      darkButtons: false,
    })
  })

  it("syncWithTheme picks the light hex + dark icons when resolved theme is light", async () => {
    const nb = makeNb()
    await syncWithTheme("light", undefined, async () => nb)
    expect(nb.setNavigationBarColor).toHaveBeenCalledWith({
      color: "#ffffff",
      darkButtons: true,
    })
  })

  it("syncWithTheme defaults to the light hex when the theme name is unknown", async () => {
    const nb = makeNb()
    await syncWithTheme(undefined, undefined, async () => nb)
    expect(nb.setNavigationBarColor).toHaveBeenCalledWith({
      color: "#ffffff",
      darkButtons: true,
    })
  })

  it("syncWithTheme prefers a token-derived backgroundHex over the historical fallback", async () => {
    const nb = makeNb()
    await syncWithTheme("dark", "#ff8800", async () => nb)
    expect(nb.setNavigationBarColor).toHaveBeenCalledWith({
      color: "#ff8800",
      darkButtons: false,
    })
  })

  it("returns unsupported when the plugin module is missing", async () => {
    const out = await setNavigationBarColor("#000000", true, async () => {
      throw new Error("plugin not installed")
    })
    expect(out).toEqual({ kind: "unsupported" })
  })

  it("propagates an error envelope when the native call throws", async () => {
    const nb = {
      setNavigationBarColor: jest.fn().mockRejectedValue(new Error("native blew up")),
    }
    const out = await setNavigationBarColor("#000000", true, async () => nb)
    expect(out).toEqual({ kind: "error", message: "native blew up" })
  })
})

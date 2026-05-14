/**
 * @jest-environment jsdom
 */
import { setNavigationBarColor, setLightContent, syncWithTheme } from "./navigation-bar"

function makeNb(opts: { withLight?: boolean } = {}) {
  return {
    setNavigationBarColor: jest.fn().mockResolvedValue(undefined),
    ...(opts.withLight !== false
      ? { setNavigationBarLight: jest.fn().mockResolvedValue(undefined) }
      : {}),
  }
}

describe("navigation-bar wrapper", () => {
  it("setNavigationBarColor forwards the hex color", async () => {
    const nb = makeNb()
    const out = await setNavigationBarColor("#abcdef", async () => nb)
    expect(out).toEqual({ kind: "ok" })
    expect(nb.setNavigationBarColor).toHaveBeenCalledWith({ color: "#abcdef" })
  })

  it("setLightContent calls setNavigationBarLight when the plugin exposes it", async () => {
    const nb = makeNb()
    await setLightContent(true, async () => nb)
    expect(nb.setNavigationBarLight).toHaveBeenCalledWith({ light: true })
  })

  it("setLightContent is a no-op when the plugin lacks setNavigationBarLight", async () => {
    const nb = makeNb({ withLight: false })
    const out = await setLightContent(true, async () => nb)
    expect(out).toEqual({ kind: "ok" })
  })

  it("syncWithTheme picks the dark hex when resolved theme is dark", async () => {
    const nb = makeNb()
    await syncWithTheme("dark", async () => nb)
    expect(nb.setNavigationBarColor).toHaveBeenCalledWith({ color: "#0a0a0a" })
    expect(nb.setNavigationBarLight).toHaveBeenCalledWith({ light: true })
  })

  it("syncWithTheme picks the light hex when resolved theme is light", async () => {
    const nb = makeNb()
    await syncWithTheme("light", async () => nb)
    expect(nb.setNavigationBarColor).toHaveBeenCalledWith({ color: "#ffffff" })
    expect(nb.setNavigationBarLight).toHaveBeenCalledWith({ light: false })
  })

  it("syncWithTheme defaults to the light hex when the theme name is unknown", async () => {
    const nb = makeNb()
    await syncWithTheme(undefined, async () => nb)
    expect(nb.setNavigationBarColor).toHaveBeenCalledWith({ color: "#ffffff" })
  })

  it("returns unsupported when the plugin module is missing", async () => {
    const out = await setNavigationBarColor("#000000", async () => {
      throw new Error("plugin not installed")
    })
    expect(out).toEqual({ kind: "unsupported" })
  })

  it("propagates an error envelope when the native call throws", async () => {
    const nb = {
      setNavigationBarColor: jest.fn().mockRejectedValue(new Error("native blew up")),
    }
    const out = await setNavigationBarColor("#000000", async () => nb)
    expect(out).toEqual({ kind: "error", message: "native blew up" })
  })
})

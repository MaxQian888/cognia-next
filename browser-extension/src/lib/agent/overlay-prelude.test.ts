import { installOverlayPrelude } from "./overlay-prelude"

describe("installOverlayPrelude", () => {
  it("silences every sentinel channel and forwards new-tab opens", () => {
    const win = {} as Window & Record<string, unknown>
    const opened: string[] = []
    installOverlayPrelude(win, (url) => opened.push(url))
    for (const name of [
      "__cogniaSignal",
      "__cogniaSignalNav",
      "__cogniaSignalLoaded",
      "__cogniaSignalPush",
    ]) {
      expect(typeof win[name]).toBe("function")
      expect((win[name] as () => unknown)()).toBeUndefined()
    }
    ;(win.__cogniaNavTo as (url: unknown) => void)("https://example.com/next")
    ;(win.__cogniaNavTo as (url: unknown) => void)(42)
    expect(opened).toEqual(["https://example.com/next"])
  })

  it("installs once", () => {
    const win = {} as Window & Record<string, unknown>
    const first = jest.fn()
    installOverlayPrelude(win, first)
    installOverlayPrelude(win, jest.fn())
    ;(win.__cogniaNavTo as (url: unknown) => void)("https://example.com/")
    expect(first).toHaveBeenCalledTimes(1)
  })
})

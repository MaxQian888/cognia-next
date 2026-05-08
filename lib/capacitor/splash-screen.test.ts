/**
 * @jest-environment jsdom
 */
import { hide, show } from "./splash-screen"

describe("splash-screen", () => {
  it("show forwards options", async () => {
    const showFn = jest.fn().mockResolvedValue(undefined)
    await show({
      showDuration: 1000,
      autoHide: true,
      loader: async () => ({ show: showFn, hide: jest.fn() }),
    })
    expect(showFn).toHaveBeenCalledWith({ showDuration: 1000, autoHide: true })
  })

  it("hide passes fadeOutDuration", async () => {
    const hideFn = jest.fn().mockResolvedValue(undefined)
    await hide(300, async () => ({ show: jest.fn(), hide: hideFn }))
    expect(hideFn).toHaveBeenCalledWith({ fadeOutDuration: 300 })
  })

  it("hide with no duration passes undefined", async () => {
    const hideFn = jest.fn().mockResolvedValue(undefined)
    await hide(undefined, async () => ({ show: jest.fn(), hide: hideFn }))
    expect(hideFn).toHaveBeenCalledWith({ fadeOutDuration: undefined })
  })

  it("returns unsupported when plugin missing", async () => {
    const out = await show({
      loader: async () => {
        throw new Error("not native")
      },
    })
    expect(out).toEqual({ kind: "unsupported" })
  })
})

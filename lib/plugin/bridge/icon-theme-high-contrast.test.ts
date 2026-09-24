import {
  __resetIconThemeHighContrastForTesting,
  isIconThemeHighContrast,
  setIconThemeHighContrast,
  subscribeIconThemeHighContrast,
} from "./icon-theme-high-contrast"

describe("icon-theme high-contrast signal", () => {
  beforeEach(() => __resetIconThemeHighContrastForTesting())

  it("starts off and follows what the theme applier publishes", () => {
    expect(isIconThemeHighContrast()).toBe(false)
    setIconThemeHighContrast(true)
    expect(isIconThemeHighContrast()).toBe(true)
    setIconThemeHighContrast(false)
    expect(isIconThemeHighContrast()).toBe(false)
  })

  it("notifies subscribers on a change only, and stops after unsubscribing", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeIconThemeHighContrast(listener)

    setIconThemeHighContrast(true)
    // The applier republishes on every repaint; icons re-render on changes.
    setIconThemeHighContrast(true)
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    setIconThemeHighContrast(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("resets the value and its subscribers", () => {
    const listener = jest.fn()
    subscribeIconThemeHighContrast(listener)
    setIconThemeHighContrast(true)
    __resetIconThemeHighContrastForTesting()

    expect(isIconThemeHighContrast()).toBe(false)
    setIconThemeHighContrast(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

/**
 * @jest-environment jsdom
 */
import { renderHook, act } from "@testing-library/react"

import { useMobileTabLayout } from "./use-mobile-tab-layout"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_MOBILE_TAB_LAYOUT, type MobileTabLayout } from "@/types/shell/mobile-tabs"

const saveMock = jest.fn(async (_patch?: { mobileTabLayout?: MobileTabLayout }) => {})

function setLayout(layout?: MobileTabLayout) {
  useSettingsStore.setState({
    settings: (layout ? { mobileTabLayout: layout } : {}) as never,
    save: saveMock as never,
  })
}

const lastSaved = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.mobileTabLayout as MobileTabLayout

beforeEach(() => {
  saveMock.mockClear()
  setLayout(undefined)
})

describe("useMobileTabLayout", () => {
  it("defaults when settings are empty", () => {
    const { result } = renderHook(() => useMobileTabLayout())
    expect(result.current.layout).toEqual(DEFAULT_MOBILE_TAB_LAYOUT)
    expect(result.current.resolved.visible).toEqual(["chat", "workflows", "discover", "me"])
  })

  it("reorders, filtering invalid ids", async () => {
    const { result } = renderHook(() => useMobileTabLayout())
    await act(async () => {
      await result.current.reorder(["me", "chat", "bogus" as never])
    })
    expect(lastSaved().order).toEqual(["me", "chat"])
  })

  it("hides a tab when above the floor", async () => {
    const { result } = renderHook(() => useMobileTabLayout())
    await act(async () => {
      await result.current.hide("discover")
    })
    expect(lastSaved().hidden).toEqual(["discover"])
  })

  it("refuses to hide when at the visible floor", async () => {
    setLayout({
      order: ["chat", "workflows", "discover", "me"],
      hidden: ["discover", "me"],
      defaultLanding: "chat",
    })
    const { result } = renderHook(() => useMobileTabLayout())
    expect(result.current.resolved.visible).toEqual(["chat", "workflows"])
    await act(async () => {
      await result.current.hide("workflows")
    })
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("shows a hidden tab", async () => {
    setLayout({
      order: ["chat", "workflows", "discover", "me"],
      hidden: ["discover"],
      defaultLanding: "chat",
    })
    const { result } = renderHook(() => useMobileTabLayout())
    await act(async () => {
      await result.current.show("discover")
    })
    expect(lastSaved().hidden).toEqual([])
  })

  it("sets the default landing", async () => {
    const { result } = renderHook(() => useMobileTabLayout())
    await act(async () => {
      await result.current.setDefaultLanding("workflows")
    })
    expect(lastSaved().defaultLanding).toBe("workflows")
  })

  it("resets to defaults", async () => {
    setLayout({ order: ["me", "chat"], hidden: ["discover"], defaultLanding: "me" })
    const { result } = renderHook(() => useMobileTabLayout())
    await act(async () => {
      await result.current.reset()
    })
    expect(lastSaved()).toEqual(DEFAULT_MOBILE_TAB_LAYOUT)
  })
})

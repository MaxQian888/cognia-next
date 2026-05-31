/**
 * @jest-environment jsdom
 */
import { renderHook, act } from "@testing-library/react"

import { useMobileHomeLayout } from "./use-mobile-home-layout"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_MOBILE_HOME_LAYOUT, type MobileHomeLayout } from "@/types/shell/mobile-home"

const saveMock = jest.fn(async (_patch?: { mobileHomeLayout?: MobileHomeLayout }) => {})

function setLayout(layout?: MobileHomeLayout) {
  useSettingsStore.setState({
    settings: (layout ? { mobileHomeLayout: layout } : {}) as never,
    save: saveMock as never,
  })
}

const lastSaved = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.mobileHomeLayout as MobileHomeLayout

beforeEach(() => {
  saveMock.mockClear()
  setLayout({ quickActions: ["newChat", "search"], hiddenSections: [] })
})

describe("useMobileHomeLayout", () => {
  it("falls back to the default layout when settings are empty", () => {
    setLayout(undefined)
    const { result } = renderHook(() => useMobileHomeLayout())
    expect(result.current.layout).toEqual(DEFAULT_MOBILE_HOME_LAYOUT)
  })

  it("adds an available action to the end of the grid", async () => {
    const { result } = renderHook(() => useMobileHomeLayout())
    await act(async () => {
      await result.current.addAction("workflows")
    })
    expect(lastSaved().quickActions).toEqual(["newChat", "search", "workflows"])
  })

  it("ignores adding a duplicate or unknown action", async () => {
    const { result } = renderHook(() => useMobileHomeLayout())
    await act(async () => {
      await result.current.addAction("newChat")
    })
    expect(lastSaved().quickActions).toEqual(["newChat", "search"])
    await act(async () => {
      await result.current.addAction("nope")
    })
    expect(lastSaved().quickActions).toEqual(["newChat", "search"])
  })

  it("removes an action from the grid", async () => {
    const { result } = renderHook(() => useMobileHomeLayout())
    await act(async () => {
      await result.current.removeAction("search")
    })
    expect(lastSaved().quickActions).toEqual(["newChat"])
  })

  it("reorders, filtering out invalid ids", async () => {
    const { result } = renderHook(() => useMobileHomeLayout())
    await act(async () => {
      await result.current.reorderActions(["search", "bogus", "newChat"])
    })
    expect(lastSaved().quickActions).toEqual(["search", "newChat"])
  })

  it("hides and shows a section", async () => {
    const { result } = renderHook(() => useMobileHomeLayout())
    expect(result.current.isSectionHidden("recents")).toBe(false)
    await act(async () => {
      await result.current.hideSection("recents")
    })
    expect(lastSaved().hiddenSections).toEqual(["recents"])

    setLayout({ quickActions: ["newChat"], hiddenSections: ["recents"] })
    const { result: r2 } = renderHook(() => useMobileHomeLayout())
    expect(r2.current.isSectionHidden("recents")).toBe(true)
    await act(async () => {
      await r2.current.showSection("recents")
    })
    expect(lastSaved().hiddenSections).toEqual([])
  })

  it("does not duplicate a section already hidden", async () => {
    setLayout({ quickActions: ["newChat"], hiddenSections: ["recents"] })
    const { result } = renderHook(() => useMobileHomeLayout())
    await act(async () => {
      await result.current.hideSection("recents")
    })
    expect(lastSaved().hiddenSections).toEqual(["recents"])
  })

  it("resets to the default layout", async () => {
    const { result } = renderHook(() => useMobileHomeLayout())
    await act(async () => {
      await result.current.reset()
    })
    expect(lastSaved()).toEqual(DEFAULT_MOBILE_HOME_LAYOUT)
  })
})

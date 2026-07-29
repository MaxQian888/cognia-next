/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { useSidebarLayout } from "./use-sidebar-layout"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_SIDEBAR_LAYOUT, DEFAULT_SIDEBAR_SIDE } from "@/types/shell/sidebar"

interface SavePatch {
  sidebarLayout?: { pinned: string[]; hidden: string[] }
  sidebarSide?: "left" | "right"
}

const saveMock = jest.fn(async (_patch?: SavePatch) => {})

beforeEach(() => {
  saveMock.mockClear()
  useSettingsStore.setState({
    settings: { sidebarLayout: { pinned: ["workflows", "inbox"], hidden: [] } } as never,
    save: saveMock as never,
  })
})

const lastPatch = () => saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0] as SavePatch

const lastSaved = () =>
  lastPatch()?.sidebarLayout as {
    pinned: string[]
    hidden: string[]
  }

describe("useSidebarLayout", () => {
  it("resolves pinned/overflow/hidden from settings", () => {
    const { result } = renderHook(() => useSidebarLayout())
    expect(result.current.resolved.pinned.map((i) => i.id)).toEqual(["workflows", "inbox"])
    // Everything else is in overflow.
    expect(result.current.resolved.overflow.map((i) => i.id)).toContain("twin")
    expect(result.current.resolved.hidden).toEqual([])
  })

  it("falls back to the default layout when unset", () => {
    useSettingsStore.setState({ settings: {} as never })
    const { result } = renderHook(() => useSidebarLayout())
    expect(result.current.layout.pinned).toEqual(DEFAULT_SIDEBAR_LAYOUT.pinned)
  })

  it("pins an item to the end and unhides it", async () => {
    useSettingsStore.setState({
      settings: { sidebarLayout: { pinned: ["workflows"], hidden: ["logs"] } } as never,
    })
    const { result } = renderHook(() => useSidebarLayout())
    await act(async () => {
      await result.current.pin("logs")
    })
    expect(lastSaved()).toEqual({ pinned: ["workflows", "logs"], hidden: [] })
  })

  it("does not duplicate an already-pinned id", async () => {
    const { result } = renderHook(() => useSidebarLayout())
    await act(async () => {
      await result.current.pin("workflows")
    })
    expect(lastSaved().pinned).toEqual(["workflows", "inbox"])
  })

  it("unpins an item (it drops to overflow)", async () => {
    const { result } = renderHook(() => useSidebarLayout())
    await act(async () => {
      await result.current.unpin("inbox")
    })
    expect(lastSaved()).toEqual({ pinned: ["workflows"], hidden: [] })
  })

  it("does not recompute layout/callbacks when an unrelated setting changes", () => {
    const { result, rerender } = renderHook(() => useSidebarLayout())
    const firstLayout = result.current.layout
    const firstPin = result.current.pin
    // An unrelated settings write swaps in a fresh `settings` object reference
    // but keeps the SAME `sidebarLayout` reference — the memo (keyed on
    // `settings.sidebarLayout`, not the whole object) must hold its identity.
    const existingLayout = (useSettingsStore.getState().settings as { sidebarLayout: unknown })
      .sidebarLayout
    act(() => {
      useSettingsStore.setState({
        settings: { theme: "dark", sidebarLayout: existingLayout } as never,
      })
    })
    rerender()
    expect(result.current.layout).toBe(firstLayout)
    expect(result.current.pin).toBe(firstPin)
  })

  it("hides an item and unpins it", async () => {
    const { result } = renderHook(() => useSidebarLayout())
    await act(async () => {
      await result.current.hide("inbox")
    })
    expect(lastSaved()).toEqual({ pinned: ["workflows"], hidden: ["inbox"] })
  })

  it("shows a hidden item", async () => {
    useSettingsStore.setState({
      settings: { sidebarLayout: { pinned: [], hidden: ["logs", "me"] } } as never,
    })
    const { result } = renderHook(() => useSidebarLayout())
    await act(async () => {
      await result.current.show("logs")
    })
    expect(lastSaved()).toEqual({ pinned: [], hidden: ["me"] })
  })

  it("reorders pinned, dropping unknown ids", async () => {
    const { result } = renderHook(() => useSidebarLayout())
    await act(async () => {
      await result.current.reorderPinned(["inbox", "workflows", "ghost"])
    })
    expect(lastSaved().pinned).toEqual(["inbox", "workflows"])
  })

  it("resets to the default layout", async () => {
    const { result } = renderHook(() => useSidebarLayout())
    await act(async () => {
      await result.current.reset()
    })
    expect(lastSaved()).toEqual(DEFAULT_SIDEBAR_LAYOUT)
  })

  describe("side", () => {
    it("defaults to the shipped edge when unset", () => {
      useSettingsStore.setState({ settings: {} as never })
      const { result } = renderHook(() => useSidebarLayout())
      expect(result.current.side).toBe(DEFAULT_SIDEBAR_SIDE)
    })

    it("reads the persisted edge", () => {
      useSettingsStore.setState({
        settings: { sidebarLayout: DEFAULT_SIDEBAR_LAYOUT, sidebarSide: "left" } as never,
      })
      const { result } = renderHook(() => useSidebarLayout())
      expect(result.current.side).toBe("left")
    })

    it("writes only its own key", async () => {
      const { result } = renderHook(() => useSidebarLayout())
      await act(async () => {
        await result.current.setSide("left")
      })
      expect(lastPatch()).toEqual({ sidebarSide: "left" })
    })

    // The reason `side` is not a field on `SidebarLayout`: `pin` and `hide`
    // build a fresh layout object rather than spreading the current one, so an
    // extra field living there would be dropped on the next pin. Assert the
    // separation holds by checking those patches never mention the side.
    it.each(["pin", "hide", "unpin", "show"] as const)(
      "%s leaves the edge untouched",
      async (mutator) => {
        useSettingsStore.setState({
          settings: {
            sidebarLayout: { pinned: ["workflows"], hidden: ["logs"] },
            sidebarSide: "left",
          } as never,
        })
        const { result } = renderHook(() => useSidebarLayout())
        await act(async () => {
          await result.current[mutator]("logs")
        })
        expect(lastPatch()).not.toHaveProperty("sidebarSide")
        expect(result.current.side).toBe("left")
      }
    )

    // "Restore defaults" is about which icons are pinned. Teleporting the rail
    // across the screen is not something a user asks for by pressing it.
    it("survives a layout reset", async () => {
      useSettingsStore.setState({
        settings: { sidebarLayout: DEFAULT_SIDEBAR_LAYOUT, sidebarSide: "left" } as never,
      })
      const { result } = renderHook(() => useSidebarLayout())
      await act(async () => {
        await result.current.reset()
      })
      expect(lastPatch()).not.toHaveProperty("sidebarSide")
      expect(result.current.side).toBe("left")
    })
  })
})

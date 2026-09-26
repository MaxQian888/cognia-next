/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import {
  hideSidebarItem,
  pinSidebarItem,
  unpinSidebarItem,
  useSidebarLayout,
} from "./use-sidebar-layout"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_SIDEBAR_LAYOUT, DEFAULT_SIDEBAR_SIDE } from "@/types/shell/sidebar"
import { getCommandDescriptor } from "@/lib/tauri/command-descriptors"
import {
  __resetRuntimeSnapshotForTesting,
  setRuntimeSnapshot,
} from "@/lib/runtime/runtime-snapshot-store"

interface SavePatch {
  sidebarLayout?: {
    pinned: string[]
    hidden: string[]
    modes?: { order: string[]; hidden: string[] }
  }
  sidebarSide?: "left" | "right"
}

const saveMock = jest.fn(async (_patch?: SavePatch) => {})

beforeEach(() => {
  saveMock.mockReset().mockResolvedValue(undefined)
  useSettingsStore.setState({
    settings: { sidebarLayout: { pinned: ["workflows", "inbox"], hidden: [] } } as never,
    save: saveMock as never,
  })
  setRuntimeSnapshot({
    target: { id: "web-standalone", kind: "standalone", platform: "web" },
    vaultState: "unlocked",
    connectionState: "online",
  })
})

afterEach(() => {
  __resetRuntimeSnapshotForTesting()
})

const lastPatch = () => saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0] as SavePatch

const lastSaved = () =>
  lastPatch()?.sidebarLayout as {
    pinned: string[]
    hidden: string[]
    modes?: { order: string[]; hidden: string[] }
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

  it("restores a host-only surface only when the active Companion advertises and grants it", () => {
    const operation = "browser_session_ensure"
    const capability = getCommandDescriptor(operation)?.capability
    expect(capability).toBeDefined()
    setRuntimeSnapshot({
      target: {
        id: "desktop-studio",
        kind: "companion",
        platform: "web",
        hostKind: "desktop",
      },
      vaultState: "unlocked",
      connectionState: "online",
      host: {
        compatible: true,
        operations: [operation],
        grants: [capability!],
      },
    })

    const { result } = renderHook(() => useSidebarLayout())

    expect(result.current.catalog.map((item) => item.id)).toContain("browser")
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

  it("serializes rapid pins against the latest persisted layout", async () => {
    useSettingsStore.setState({
      settings: {
        sidebarLayout: { pinned: ["workflows"], hidden: ["logs", "me"] },
      } as never,
    })
    saveMock.mockImplementation(async (patch?: SavePatch) => {
      await Promise.resolve()
      const current = useSettingsStore.getState().settings
      useSettingsStore.setState({ settings: { ...current, ...patch } as never })
    })
    const { result } = renderHook(() => useSidebarLayout())

    await act(async () => {
      await Promise.all([result.current.pin("logs"), result.current.pin("me")])
    })

    expect(lastSaved()).toEqual({ pinned: ["workflows", "logs", "me"], hidden: [] })
  })

  it("unpins an item (it drops to overflow)", async () => {
    const { result } = renderHook(() => useSidebarLayout())
    await act(async () => {
      await result.current.unpin("inbox")
    })
    expect(lastSaved()).toEqual({ pinned: ["workflows"], hidden: [] })
  })

  it("does not recompute layout/callbacks when an unrelated setting changes", () => {
    let renderCount = 0
    const { result } = renderHook(() => {
      renderCount += 1
      return useSidebarLayout()
    })
    const firstLayout = result.current.layout
    const firstPin = result.current.pin
    const initialRenderCount = renderCount
    // The persisted settings path may hydrate fresh objects and arrays even
    // when the layout values did not change. Content-stable selectors must
    // still prevent the always-mounted rail from rendering again.
    act(() => {
      useSettingsStore.setState({
        settings: {
          theme: "dark",
          sidebarLayout: { pinned: ["workflows", "inbox"], hidden: [] },
        } as never,
      })
    })
    expect(renderCount).toBe(initialRenderCount)
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

  it("keeps stored pins the runtime-filtered catalog cannot show during a reorder", async () => {
    // `browser` is host-backed: a standalone web target has no paired desktop,
    // so the catalog omits it — but the pin must survive a drag of the others.
    useSettingsStore.setState({
      settings: {
        sidebarLayout: { pinned: ["workflows", "browser", "inbox"], hidden: [] },
      } as never,
    })
    const { result } = renderHook(() => useSidebarLayout())
    expect(result.current.resolved.pinned.map((i) => i.id)).toEqual(["workflows", "inbox"])
    await act(async () => {
      await result.current.reorderPinned(["inbox", "workflows"])
    })
    expect(lastSaved().pinned).toEqual(["inbox", "workflows", "browser"])
  })

  it("drops retired ids and duplicates from a reorder", async () => {
    useSettingsStore.setState({
      settings: { sidebarLayout: { pinned: ["workflows", "retired-page"], hidden: [] } } as never,
    })
    const { result } = renderHook(() => useSidebarLayout())
    await act(async () => {
      await result.current.reorderPinned(["workflows", "workflows"])
    })
    expect(lastSaved().pinned).toEqual(["workflows"])
  })

  describe("renamed ids", () => {
    beforeEach(() => {
      useSettingsStore.setState({
        settings: { sidebarLayout: { pinned: ["agent-teams", "inbox"], hidden: [] } } as never,
      })
    })

    it("hides an item stored under its legacy id", async () => {
      const { result } = renderHook(() => useSidebarLayout())
      expect(result.current.resolved.pinned.map((i) => i.id)).toContain("squads")
      await act(async () => {
        await result.current.hide("squads")
      })
      expect(lastSaved()).toEqual({ pinned: ["inbox"], hidden: ["squads"] })
    })

    it("moves an item stored under its legacy id to More", async () => {
      const { result } = renderHook(() => useSidebarLayout())
      await act(async () => {
        await result.current.unpin("squads")
      })
      expect(lastSaved()).toEqual({ pinned: ["inbox"], hidden: [] })
    })

    it("does not duplicate a pin that exists under both names", async () => {
      useSettingsStore.setState({
        settings: {
          sidebarLayout: { pinned: ["agent-teams", "squads", "inbox"], hidden: [] },
        } as never,
      })
      const { result } = renderHook(() => useSidebarLayout())
      await act(async () => {
        await result.current.pin("inbox")
      })
      expect(lastSaved().pinned).toEqual(["squads", "inbox"])
    })
  })

  it("resets to the default layout", async () => {
    const { result } = renderHook(() => useSidebarLayout())
    await act(async () => {
      await result.current.reset()
    })
    expect(lastSaved()).toEqual(DEFAULT_SIDEBAR_LAYOUT)
  })

  it("moves a pinned item by one slot, and not past either end", async () => {
    const { result } = renderHook(() => useSidebarLayout())
    await act(async () => {
      await result.current.movePinned("workflows", 1)
    })
    expect(lastSaved().pinned).toEqual(["inbox", "workflows"])
    saveMock.mockClear()
    await act(async () => {
      await result.current.movePinned("workflows", -1)
      await result.current.movePinned("inbox", 1)
    })
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("exposes the mutations as plain functions for callers outside React", async () => {
    await act(async () => {
      await pinSidebarItem("twin")
    })
    expect(lastSaved().pinned).toEqual(["workflows", "inbox", "twin"])
    await act(async () => {
      await unpinSidebarItem("inbox")
    })
    expect(lastSaved().pinned).toEqual(["workflows"])
    await act(async () => {
      await hideSidebarItem("workflows")
    })
    expect(lastSaved()).toEqual({ pinned: ["inbox"], hidden: ["workflows"] })
  })

  describe("workspace modes", () => {
    const modes = { order: ["p:a", "canvas"], hidden: ["canvas"] }
    beforeEach(() => {
      useSettingsStore.setState({
        settings: { sidebarLayout: { pinned: ["workflows"], hidden: [], modes } } as never,
        save: saveMock as never,
      })
    })

    it("reads an absent mode layout as the default", () => {
      useSettingsStore.setState({
        settings: { sidebarLayout: { pinned: ["workflows"], hidden: [] } } as never,
      })
      const { result } = renderHook(() => useSidebarLayout())
      expect(result.current.modes).toBeUndefined()
      expect(result.current.layout).toEqual({ pinned: ["workflows"], hidden: [] })
    })

    it("never drops the mode layout when a feature is pinned, unpinned, hidden or shown", async () => {
      const { result } = renderHook(() => useSidebarLayout())
      expect(result.current.modes).toEqual(modes)
      for (const run of [
        () => result.current.pin("twin"),
        () => result.current.unpin("workflows"),
        () => result.current.hide("inbox"),
        () => result.current.show("inbox"),
        () => result.current.reorderPinned(["workflows"]),
      ]) {
        await act(async () => {
          await run()
        })
        expect(lastSaved().modes).toEqual(modes)
      }
    })

    it("hides and shows a mode, keeping its slot", async () => {
      const { result } = renderHook(() => useSidebarLayout())
      await act(async () => {
        await result.current.hideMode("p:a")
      })
      expect(lastSaved().modes).toEqual({ order: ["p:a", "canvas"], hidden: ["canvas", "p:a"] })
      await act(async () => {
        await result.current.showMode("canvas")
      })
      expect(lastSaved().modes).toEqual({ order: ["p:a", "canvas"], hidden: [] })
    })

    it("reorders modes, keeping stored ids the caller cannot see after them", async () => {
      const { result } = renderHook(() => useSidebarLayout())
      await act(async () => {
        await result.current.reorderModes(["canvas", "canvas"])
      })
      expect(lastSaved().modes).toEqual({ order: ["canvas", "p:a"], hidden: ["canvas"] })
    })

    it("resets the modes on their own, and the features without touching them", async () => {
      const { result } = renderHook(() => useSidebarLayout())
      await act(async () => {
        await result.current.resetModes()
      })
      expect(lastSaved()).toEqual({ pinned: ["workflows"], hidden: [] })
      await act(async () => {
        await result.current.reset()
      })
      expect(lastSaved()).toEqual({ ...DEFAULT_SIDEBAR_LAYOUT, modes })
    })
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

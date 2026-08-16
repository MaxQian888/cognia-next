/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { useBarLayout } from "./use-bar-layout"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useUIStore, DEFAULT_BAR_ITEMS } from "@/stores/ui/ui-store"
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  DEFAULT_TITLE_BAR_LAYOUT,
  type BarLayout,
} from "@/types/shell/bars"

// The catalog's platform filter reads `usePlatform`. Default to the desktop
// shell (where every segment exists) and let a test switch it to "web" to
// exercise the desktop-only filter.
let mockPlatform: "tauri" | "web" = "tauri"
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => mockPlatform }))

const saveMock = jest.fn(
  async (_patch?: { titleBarLayout?: BarLayout; statusBarLayout?: BarLayout }) => {}
)

beforeEach(() => {
  saveMock.mockClear()
  useSettingsStore.setState({ settings: {} as never, save: saveMock as never })
  useUIStore.setState({ barItems: { ...DEFAULT_BAR_ITEMS } })
})

const lastSaved = (key: "titleBarLayout" | "statusBarLayout"): BarLayout =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.[key] as BarLayout

const ids = (items: { id: string }[]) => items.map((i) => i.id)

describe("useBarLayout — resolution", () => {
  it("resolves the shipped default when settings hold no layout", () => {
    const { result } = renderHook(() => useBarLayout("status"))
    expect(ids(result.current.resolved.zones.start)).toEqual(["connectivity", "branch", "sync"])
    expect(ids(result.current.resolved.hidden)).toEqual(["terminal", "perf"])
    expect(result.current.isDefault).toBe(true)
  })

  it("resolves a stored layout over the default", () => {
    useSettingsStore.setState({
      settings: {
        statusBarLayout: { order: ["branch", "connectivity"], hidden: ["connectivity"] },
      } as never,
    })
    const { result } = renderHook(() => useBarLayout("status"))
    expect(ids(result.current.resolved.zones.start)).toEqual(["branch", "sync", "terminal"])
    expect(ids(result.current.resolved.hidden)).toEqual(["connectivity"])
    expect(result.current.isDefault).toBe(false)
  })

  it("fills in a half-written stored layout from the shipped default", () => {
    // A layout persisted by an older build (or hand-edited) may carry only one
    // of the two arrays; the missing one must not resolve as `undefined`.
    useSettingsStore.setState({
      settings: { statusBarLayout: { hidden: ["branch"] } } as never,
    })
    const { result } = renderHook(() => useBarLayout("status"))
    expect(result.current.layout.order).toEqual(DEFAULT_STATUS_BAR_LAYOUT.order)
    expect(ids(result.current.resolved.hidden)).toEqual(["branch"])
  })

  it("reads each bar from its own settings key", () => {
    useSettingsStore.setState({
      settings: { titleBarLayout: { order: [], hidden: ["search"] } } as never,
    })
    const title = renderHook(() => useBarLayout("title"))
    expect(ids(title.result.current.resolved.hidden)).toContain("search")
    // The status bar is untouched by the title bar's layout.
    const status = renderHook(() => useBarLayout("status"))
    expect(ids(status.result.current.resolved.hidden)).toEqual(["terminal", "perf"])
  })

  it("does not recompute layout/callbacks when an unrelated setting changes", () => {
    const stored = { order: DEFAULT_STATUS_BAR_LAYOUT.order, hidden: [] }
    useSettingsStore.setState({ settings: { statusBarLayout: stored } as never })
    const { result, rerender } = renderHook(() => useBarLayout("status"))
    const firstLayout = result.current.layout
    const firstHide = result.current.hide
    act(() => {
      // Fresh `settings` object, same `statusBarLayout` reference: the memo is
      // keyed on the field, so the always-mounted bar must not re-render.
      useSettingsStore.setState({ settings: { theme: "dark", statusBarLayout: stored } as never })
    })
    rerender()
    expect(result.current.layout).toBe(firstLayout)
    expect(result.current.hide).toBe(firstHide)
  })
})

describe("useBarLayout — legacy migration", () => {
  it("carries a legacy opt-out into the first resolved layout", () => {
    useUIStore.setState({ barItems: { ...DEFAULT_BAR_ITEMS, usage: false } })
    const { result } = renderHook(() => useBarLayout("status"))
    // `terminal` is not a legacy id; it stays on its shipped (hidden) default.
    expect(ids(result.current.resolved.hidden).sort()).toEqual(["perf", "terminal", "usage"])
    expect(result.current.isDefault).toBe(false)
  })

  it("carries a legacy opt-in for a hidden-by-default segment", () => {
    useUIStore.setState({ barItems: { ...DEFAULT_BAR_ITEMS, perf: true } })
    const { result } = renderHook(() => useBarLayout("status"))
    expect(ids(result.current.resolved.hidden)).toEqual(["terminal"])
  })

  it("migrates a fresh install to exactly the shipped default", () => {
    const title = renderHook(() => useBarLayout("title"))
    expect(title.result.current.isDefault).toBe(true)
    expect(ids(title.result.current.resolved.hidden).sort()).toEqual(["accountTop", "quickActions"])
  })

  it("falls back to the shipped default when the legacy map is empty", () => {
    useUIStore.setState({ barItems: {} as never })
    const { result } = renderHook(() => useBarLayout("title"))
    expect(result.current.layout).toEqual(DEFAULT_TITLE_BAR_LAYOUT)
  })

  it("stops consulting the legacy map once settings hold a layout", () => {
    useUIStore.setState({ barItems: { ...DEFAULT_BAR_ITEMS, usage: false } })
    useSettingsStore.setState({
      settings: {
        statusBarLayout: { order: DEFAULT_STATUS_BAR_LAYOUT.order, hidden: [] },
      } as never,
    })
    const { result } = renderHook(() => useBarLayout("status"))
    expect(ids(result.current.resolved.hidden)).toEqual([])
  })
})

describe("useBarLayout — mutations", () => {
  it("hides an item, keeping its slot in the order", async () => {
    const { result } = renderHook(() => useBarLayout("status"))
    await act(async () => {
      await result.current.hide("branch")
    })
    const saved = lastSaved("statusBarLayout")
    expect(saved.hidden).toContain("branch")
    expect(saved.order.indexOf("branch")).toBe(DEFAULT_STATUS_BAR_LAYOUT.order.indexOf("branch"))
  })

  it("appends an id the stored order never mentioned when hiding it", async () => {
    useSettingsStore.setState({
      settings: { statusBarLayout: { order: ["connectivity"], hidden: [] } } as never,
    })
    const { result } = renderHook(() => useBarLayout("status"))
    await act(async () => {
      await result.current.hide("branch")
    })
    const saved = lastSaved("statusBarLayout")
    expect(saved.order).toEqual(["connectivity", "branch"])
    expect(saved.hidden).toEqual(["branch"])
  })

  it("does not duplicate an already-hidden id", async () => {
    const { result } = renderHook(() => useBarLayout("status"))
    await act(async () => {
      await result.current.hide("perf")
    })
    expect(lastSaved("statusBarLayout").hidden).toEqual(["terminal", "perf"])
  })

  it("shows a hidden item", async () => {
    const { result } = renderHook(() => useBarLayout("status"))
    await act(async () => {
      await result.current.show("perf")
    })
    expect(lastSaved("statusBarLayout").hidden).toEqual(["terminal"])
  })

  it("reorders, dropping ids that are not in the catalog", async () => {
    const { result } = renderHook(() => useBarLayout("title"))
    await act(async () => {
      await result.current.reorder(["search", "appIcon", "ghost"])
    })
    const saved = lastSaved("titleBarLayout")
    expect(saved.order.slice(0, 2)).toEqual(["search", "appIcon"])
    expect(saved.order).not.toContain("ghost")
  })

  it("preserves stored ids the platform filter hid from the customizer", async () => {
    mockPlatform = "web"
    useSettingsStore.setState({
      settings: {
        statusBarLayout: { order: ["connectivity", "sync", "branch", "perf"], hidden: [] },
      } as never,
    })
    const { result } = renderHook(() => useBarLayout("status"))
    // `sync` / `perf` are desktop-only, so a browser customizer never showed
    // them and cannot submit them. They must survive the write, or switching
    // back to the desktop shell would silently reset them.
    expect(ids(result.current.resolved.order)).not.toContain("sync")
    await act(async () => {
      await result.current.reorder(["branch", "connectivity"])
    })
    expect(lastSaved("statusBarLayout").order).toEqual(["branch", "connectivity", "sync", "perf"])
    mockPlatform = "tauri"
  })

  it("resets a single bar to its factory default", async () => {
    useSettingsStore.setState({
      settings: { statusBarLayout: { order: ["runStatus"], hidden: ["branch"] } } as never,
    })
    const { result } = renderHook(() => useBarLayout("status"))
    await act(async () => {
      await result.current.reset()
    })
    expect(lastSaved("statusBarLayout")).toEqual(DEFAULT_STATUS_BAR_LAYOUT)
  })
})

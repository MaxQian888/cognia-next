/** @jest-environment jsdom */

import { act, fireEvent, render, renderHook, screen } from "@testing-library/react"
import { Suspense, useState } from "react"
import type { SelectedGuild } from "@/stores/ui"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_SIDEBAR_LAYOUT } from "@/types/shell/sidebar"

const logInfo = jest.fn()
jest.mock("@cognia/logging", () => {
  const stub = {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: function () {
      return this
    },
    withContext: function () {
      return this
    },
  }
  return {
    loggers: new Proxy(
      { ui: { ...stub, info: (...args: unknown[]) => logInfo(...args) } },
      { get: (target: Record<string, unknown>, prop: string) => target[prop] ?? stub }
    ),
    createLogger: () => stub,
  }
})

// Keys come back verbatim.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const routerPush = jest.fn()
let pathname = "/"
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: jest.fn(), back: jest.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
}))

let selectedGuild: SelectedGuild = { kind: "dm" }
const setSelectedGuild = jest.fn((g: SelectedGuild) => {
  selectedGuild = g
})
jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(
    selector: (s: {
      selectedGuild: SelectedGuild
      setSelectedGuild: (g: SelectedGuild) => void
    }) => T
  ): T => selector({ selectedGuild, setSelectedGuild }),
}))

jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => "tauri" }))

const containers: Array<{
  fullId: string
  pluginId: string
  def: {
    id: string
    location?: string
    when?: string
    title: string
    icon: string
    order?: number
  }
}> = []
jest.mock("@/lib/plugin/registries/view-container-registry", () => ({
  subscribeViewContainers: () => () => {},
  getViewContainerSnapshot: () => containers,
}))
jest.mock("@/lib/plugin/context-keys/context-key-store", () => ({
  subscribeContextKeys: () => () => {},
  getContextKeyRevision: () => 0,
  evaluateContextWhen: (when?: string) => when !== "never",
  useContextKeyStore: (select: (state: { keys: Record<string, unknown> }) => unknown) =>
    select({ keys: {} }),
}))

import { useShellNav, useShellNavModel } from "./use-shell-nav"
import { __resetNavBadgesForTests, setNavBadgeSourceCount } from "@/lib/shell/nav-badges"

const saveMock = jest.fn(
  async (_patch?: {
    sidebarLayout?: {
      pinned: string[]
      hidden: string[]
      modes?: { order: string[]; hidden: string[] }
    }
  }) => {}
)
const lastSavedLayout = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.sidebarLayout as {
    pinned: string[]
    hidden: string[]
    modes?: { order: string[]; hidden: string[] }
  }

beforeEach(() => {
  __resetNavBadgesForTests()
  saveMock.mockClear()
  logInfo.mockReset()
  routerPush.mockReset()
  setSelectedGuild.mockClear()
  selectedGuild = { kind: "dm" }
  pathname = "/"
  containers.length = 0
  act(() => {
    useSettingsStore.setState({
      settings: { sidebarLayout: { ...DEFAULT_SIDEBAR_LAYOUT } } as never,
      save: saveMock as never,
    })
  })
})

describe("useShellNav", () => {
  it("reports a cold destination until its transition commits", async () => {
    let ready = false
    let resolve!: () => void
    const destination = new Promise<void>((done) => {
      resolve = done
    })
    function Route({ route }: { route: string }) {
      if (route === "/logs" && !ready) throw destination
      return <span>{route}</span>
    }
    function Navigation() {
      const [route, setRoute] = useState("/")
      routerPush.mockImplementation(setRoute)
      const nav = useShellNav()
      return (
        <>
          <button onClick={() => nav.goToFeature("/logs")}>Logs</button>
          <output>{nav.pendingRoute ?? "idle"}</output>
          <Suspense fallback={null}>
            <Route route={route} />
          </Suspense>
        </>
      )
    }
    render(<Navigation />)
    fireEvent.click(screen.getByRole("button", { name: "Logs" }))
    expect(screen.getByRole("status")).toHaveTextContent("/logs")
    await act(async () => {
      ready = true
      resolve()
    })
    expect(screen.getByRole("status")).toHaveTextContent("idle")
  })

  it("lights the selected chat guild only on the home route", () => {
    const { result, rerender } = renderHook(() => useShellNav())
    expect(result.current.isDmActive).toBe(true)
    expect(result.current.isCanvasActive).toBe(false)
    selectedGuild = { kind: "team", teamId: "t-1" }
    rerender()
    expect(result.current.isDmActive).toBe(false)
    expect(result.current.isTeamActive("t-1")).toBe(true)
    expect(result.current.isTeamActive("t-2")).toBe(false)
    pathname = "/inbox"
    rerender()
    expect(result.current.onHomeRoute).toBe(false)
    expect(result.current.isTeamActive("t-1")).toBe(false)
  })

  it("matches feature routes by prefix and reports overflow activity", () => {
    pathname = "/skills/abc"
    const { result } = renderHook(() => useShellNav())
    expect(result.current.isFeatureActive("/skills")).toBe(true)
    expect(result.current.isFeatureActive("/skill")).toBe(false)
    // Skills is not pinned by default → it lives in More.
    expect(result.current.overflowActive).toBe(true)
    expect(result.current.layout.resolved.pinned.map((i) => i.id)).toEqual([
      ...DEFAULT_SIDEBAR_LAYOUT.pinned,
    ])
  })

  it("switches guilds in place on `/` and routes home from elsewhere", () => {
    const { result, rerender } = renderHook(() => useShellNav())
    act(() => result.current.switchToCanvas())
    expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "canvas" })
    expect(routerPush).not.toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledWith("guild switch canvas")

    pathname = "/workflows"
    rerender()
    act(() => result.current.switchToTeam("t-9"))
    expect(setSelectedGuild).toHaveBeenLastCalledWith({ kind: "team", teamId: "t-9" })
    expect(routerPush).toHaveBeenCalledWith("/")
    expect(logInfo).toHaveBeenCalledWith("guild switch team", { teamId: "t-9" })

    act(() => result.current.switchToDm())
    expect(setSelectedGuild).toHaveBeenLastCalledWith({ kind: "dm" })
    act(() => result.current.switchToViewContainer("p:v"))
    expect(setSelectedGuild).toHaveBeenLastCalledWith({ kind: "plugin-view", containerId: "p:v" })
    expect(logInfo).toHaveBeenCalledWith("guild switch plugin-view", { containerId: "p:v" })
  })

  it("navigates to a feature route and logs it", () => {
    const { result } = renderHook(() => useShellNav())
    act(() => result.current.goToFeature("/inbox"))
    expect(routerPush).toHaveBeenCalledWith("/inbox")
    expect(logInfo).toHaveBeenCalledWith("guild navigate feature", { route: "/inbox" })
  })

  it("lists only rail-placed view containers whose `when` passes, and knows the active one", () => {
    containers.push(
      { fullId: "a:rail", pluginId: "a", def: { id: "rail", title: "A", icon: "box" } },
      {
        fullId: "a:panel",
        pluginId: "a",
        def: { id: "panel", location: "panel", title: "P", icon: "box" },
      },
      {
        fullId: "a:gated",
        pluginId: "a",
        def: { id: "gated", when: "never", title: "G", icon: "box" },
      }
    )
    selectedGuild = { kind: "plugin-view", containerId: "a:rail" }
    const { result } = renderHook(() => useShellNav())
    expect(result.current.railContainers.map((c) => c.fullId)).toEqual(["a:rail"])
    expect(result.current.isViewContainerActive("a:rail")).toBe(true)
    expect(result.current.isViewContainerActive("a:panel")).toBe(false)
  })

  it("resolves the workspace modes: Canvas first, plugins by declared order, then the user's order", () => {
    containers.push(
      { fullId: "a:late", pluginId: "a", def: { id: "late", title: "L", icon: "box", order: 5 } },
      { fullId: "a:early", pluginId: "a", def: { id: "early", title: "E", icon: "box", order: 1 } }
    )
    const { result, unmount } = renderHook(() => useShellNav())
    expect(result.current.railContainers.map((c) => c.fullId)).toEqual(["a:early", "a:late"])
    expect(result.current.modes.visible.map((m) => m.id)).toEqual(["canvas", "a:early", "a:late"])
    unmount()

    act(() => {
      useSettingsStore.setState({
        settings: {
          sidebarLayout: {
            pinned: [],
            hidden: [],
            modes: { order: ["a:late", "canvas"], hidden: ["a:early"] },
          },
        } as never,
      })
    })
    const { result: stored } = renderHook(() => useShellNav())
    expect(stored.current.modes.visible.map((m) => m.id)).toEqual(["a:late", "canvas"])
    expect(stored.current.modes.hidden.map((m) => m.id)).toEqual(["a:early"])
    // The declared order is still what `railContainers` reports.
    expect(stored.current.railContainers.map((c) => c.fullId)).toEqual(["a:early", "a:late"])
  })
})

/**
 * `useShellNavModel` is everything the icon rail and the sidebar's hosted rows
 * derive from the routing model. Each surface's own suite only proves it
 * renders the model; what the model computes is pinned here, once.
 */
describe("useShellNavModel", () => {
  const vault = {
    fullId: "p:vault",
    pluginId: "p",
    def: { id: "vault", title: "Vault", icon: "box", order: 1 },
  }
  const notes = {
    fullId: "p:notes",
    pluginId: "p",
    def: { id: "notes", title: "Notes", icon: "box", order: 2 },
  }

  it("names modes and pins, and falls back to the id for anything it cannot see", () => {
    containers.push(vault)
    const { result } = renderHook(() => useShellNavModel())
    const [canvas, plugin] = result.current.modes.visible
    expect(result.current.modeLabel(canvas!)).toBe("canvas")
    // A plugin container without a locale key keeps its declared title.
    expect(result.current.modeLabel(plugin!)).toBe("Vault")
    expect(result.current.visibleModeIds).toEqual(["canvas", "p:vault"])
    expect(result.current.modeLabelById("p:vault")).toBe("Vault")
    expect(result.current.modeLabelById("p:gone")).toBe("p:gone")

    const inbox = result.current.layout.resolved.pinned.find((item) => item.id === "inbox")!
    expect(result.current.pinnedLabel(inbox)).toBe(inbox.i18nKey)
    expect(result.current.pinnedLabelById("inbox")).toBe(inbox.i18nKey)
    expect(result.current.pinnedLabelById("skills")).toBe("skills")
    expect(result.current.pinnedIds).toEqual([...DEFAULT_SIDEBAR_LAYOUT.pinned])
  })

  it("sums only the overflow's counts for More", () => {
    const { result } = renderHook(() => useShellNavModel())
    expect(result.current.overflowBadge).toBe(0)
    // Inbox is pinned: its count is its own, not More's.
    act(() => setNavBadgeSourceCount("inbox.drafts", 5))
    expect(result.current.overflowBadge).toBe(0)
    expect(result.current.badges.inbox).toBe(5)
    act(() => setNavBadgeSourceCount("agent-runs.attention", 3))
    expect(result.current.overflowBadge).toBe(3)
  })

  it("carries the ⌥N chords for the pinned slots", () => {
    const { result } = renderHook(() => useShellNavModel())
    expect(result.current.pinnedShortcuts).toHaveLength(9)
    expect(result.current.pinnedShortcuts[0]?.aria).toBe("Alt+1")
  })

  it("answers active, pending and select for a mode of either kind", () => {
    containers.push(vault)
    selectedGuild = { kind: "plugin-view", containerId: "p:vault" }
    const { result } = renderHook(() => useShellNavModel())
    const [canvas, plugin] = result.current.modes.visible
    expect(result.current.isModeActive(plugin!)).toBe(true)
    expect(result.current.isModeActive(canvas!)).toBe(false)
    // Nothing is loading, so nothing is pending.
    expect(result.current.isModePending(plugin!)).toBe(false)
    act(() => result.current.selectMode(canvas!))
    expect(setSelectedGuild).toHaveBeenLastCalledWith({ kind: "canvas" })
    act(() => result.current.selectMode(plugin!))
    expect(setSelectedGuild).toHaveBeenLastCalledWith({
      kind: "plugin-view",
      containerId: "p:vault",
    })
  })

  it("a mode's menu disables the ends, moves it, hides it and opens the customizer", async () => {
    containers.push(vault)
    const { result } = renderHook(() => useShellNavModel())
    const [canvas, plugin] = result.current.modes.visible
    const first = result.current.modeMenu(canvas!, 0)
    const last = result.current.modeMenu(plugin!, 1)
    expect([first.canMoveUp, first.canMoveDown]).toEqual([false, true])
    expect([last.canMoveUp, last.canMoveDown]).toEqual([true, false])
    // A mode has no "More" to fall back to.
    expect(first.onMoveToMore).toBeUndefined()

    await act(async () => first.onMove(1))
    expect(lastSavedLayout().modes).toEqual({ order: ["p:vault", "canvas"], hidden: [] })
    await act(async () => last.onHide())
    expect(lastSavedLayout().modes?.hidden).toContain("p:vault")

    expect(result.current.customizeOpen).toBe(false)
    act(() => first.onCustomize())
    expect(result.current.customizeOpen).toBe(true)
  })

  it("reorders the visible modes without losing a hidden mode's slot", async () => {
    containers.push(vault, notes)
    act(() => {
      useSettingsStore.setState({
        settings: {
          sidebarLayout: {
            ...DEFAULT_SIDEBAR_LAYOUT,
            modes: { order: ["canvas", "p:vault", "p:notes"], hidden: ["p:vault"] },
          },
        } as never,
      })
    })
    const { result } = renderHook(() => useShellNavModel())
    expect(result.current.visibleModeIds).toEqual(["canvas", "p:notes"])
    await act(async () => result.current.reorderVisibleModes(["p:notes", "canvas"]))
    expect(lastSavedLayout().modes).toEqual({
      order: ["p:notes", "p:vault", "canvas"],
      hidden: ["p:vault"],
    })
    // Moving past an end writes nothing.
    saveMock.mockClear()
    await act(async () => result.current.moveMode("canvas", -1))
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("a pinned feature's menu moves it, sends it to More, hides it", async () => {
    const { result } = renderHook(() => useShellNavModel())
    const pinned = result.current.layout.resolved.pinned
    const [firstId, secondId] = DEFAULT_SIDEBAR_LAYOUT.pinned
    const first = result.current.pinnedMenu(pinned[0]!, 0)
    const last = result.current.pinnedMenu(pinned[pinned.length - 1]!, pinned.length - 1)
    expect([first.canMoveUp, first.canMoveDown]).toEqual([false, true])
    expect([last.canMoveUp, last.canMoveDown]).toEqual([true, false])

    await act(async () => first.onMove(1))
    expect(lastSavedLayout().pinned.slice(0, 2)).toEqual([secondId, firstId])
    await act(async () => result.current.pinnedMenu(pinned[0]!, 0).onMoveToMore?.())
    expect(lastSavedLayout().pinned).not.toContain(firstId)
    expect(lastSavedLayout().hidden).not.toContain(firstId)
    await act(async () => last.onHide())
    expect(lastSavedLayout().hidden).toContain(pinned[pinned.length - 1]!.id)
  })

  it("drives More: open an entry, pin or hide one, or go on to the customizer", async () => {
    const { result } = renderHook(() => useShellNavModel())
    act(() => result.current.setMoreOpen(true))
    act(() => result.current.openOverflowItem("/logs"))
    expect(result.current.moreOpen).toBe(false)
    expect(routerPush).toHaveBeenCalledWith("/logs")

    await act(async () => result.current.pinItem("skills"))
    expect(lastSavedLayout().pinned).toEqual([...DEFAULT_SIDEBAR_LAYOUT.pinned, "skills"])
    await act(async () => result.current.hideItem("logs"))
    expect(lastSavedLayout().hidden).toContain("logs")

    act(() => result.current.setMoreOpen(true))
    act(() => result.current.openCustomize())
    expect(result.current.moreOpen).toBe(false)
    expect(result.current.customizeOpen).toBe(true)
  })

  it("reorders the pinned features by id", async () => {
    const { result } = renderHook(() => useShellNavModel())
    const reversed = [...DEFAULT_SIDEBAR_LAYOUT.pinned].reverse()
    await act(async () => result.current.reorderPinnedIds(reversed))
    expect(lastSavedLayout().pinned).toEqual(reversed)
  })
})

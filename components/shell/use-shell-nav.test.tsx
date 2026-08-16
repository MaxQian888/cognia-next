/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"
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
  def: { id: string; location?: string; when?: string; title: string; icon: string }
}> = []
jest.mock("@/lib/plugin/registries/view-container-registry", () => ({
  subscribeViewContainers: () => () => {},
  getViewContainerSnapshot: () => containers,
}))
jest.mock("@/lib/plugin/context-keys/context-key-store", () => ({
  subscribeContextKeys: () => () => {},
  getContextKeyRevision: () => 0,
  evaluateContextWhen: (when?: string) => when !== "never",
}))

import { useShellNav } from "./use-shell-nav"

beforeEach(() => {
  logInfo.mockReset()
  routerPush.mockReset()
  setSelectedGuild.mockClear()
  selectedGuild = { kind: "dm" }
  pathname = "/"
  containers.length = 0
  act(() => {
    useSettingsStore.setState({
      settings: { sidebarLayout: { ...DEFAULT_SIDEBAR_LAYOUT } } as never,
      save: jest.fn(async () => {}) as never,
    })
  })
})

describe("useShellNav", () => {
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
})

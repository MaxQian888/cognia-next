import { renderHook, act, waitFor } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  useMcpPanelView,
  isMcpPanelView,
  isMcpPanelGroupBy,
  DEFAULT_MCP_PANEL_PREFS,
} from "./use-mcp-panel-view"

describe("isMcpPanelView", () => {
  it("accepts grid and list", () => {
    expect(isMcpPanelView("grid")).toBe(true)
    expect(isMcpPanelView("list")).toBe(true)
  })
  it("rejects anything else", () => {
    expect(isMcpPanelView("timeline")).toBe(false)
    expect(isMcpPanelView("")).toBe(false)
  })
})

describe("isMcpPanelGroupBy", () => {
  it("accepts the three modes", () => {
    expect(isMcpPanelGroupBy("none")).toBe(true)
    expect(isMcpPanelGroupBy("transport")).toBe(true)
    expect(isMcpPanelGroupBy("status")).toBe(true)
  })
  it("rejects anything else", () => {
    expect(isMcpPanelGroupBy("favorites")).toBe(false)
  })
})

describe("useMcpPanelView", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: null })
  })

  it("defaults when unset", () => {
    const { result } = renderHook(() => useMcpPanelView())
    expect(result.current.view).toBe(DEFAULT_MCP_PANEL_PREFS.view)
    expect(result.current.groupBy).toBe("none")
    expect(result.current.favorites).toEqual([])
  })

  it("reflects persisted prefs and merges defaults over partial blobs", () => {
    useSettingsStore.setState({
      settings: { mcpPanel: { view: "list" } } as never,
    })
    const { result } = renderHook(() => useMcpPanelView())
    expect(result.current.view).toBe("list")
    // groupBy/favorites fall back to defaults when the stored blob omits them.
    expect(result.current.groupBy).toBe("none")
    expect(result.current.favorites).toEqual([])
  })

  it("persists view and groupBy via save()", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ settings: {} as never, save })
    const { result } = renderHook(() => useMcpPanelView())
    await act(async () => {
      await result.current.setView("list")
    })
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        mcpPanel: { view: "list", groupBy: "none", favorites: [] },
      })
    )
    await act(async () => {
      await result.current.setGroupBy("transport")
    })
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith({
        mcpPanel: { view: "grid", groupBy: "transport", favorites: [] },
      })
    )
  })

  it("toggles a favorite on and off", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: { mcpPanel: { view: "grid", groupBy: "none", favorites: ["a"] } } as never,
      save,
    })
    const { result } = renderHook(() => useMcpPanelView())
    expect(result.current.isFavorite("a")).toBe(true)
    expect(result.current.isFavorite("b")).toBe(false)

    // Add "b".
    await act(async () => {
      await result.current.toggleFavorite("b")
    })
    expect(save).toHaveBeenLastCalledWith({
      mcpPanel: { view: "grid", groupBy: "none", favorites: ["a", "b"] },
    })

    // Remove "a".
    await act(async () => {
      await result.current.toggleFavorite("a")
    })
    expect(save).toHaveBeenLastCalledWith({
      mcpPanel: { view: "grid", groupBy: "none", favorites: [] },
    })
  })
})

import { renderHook, act, waitFor } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useSettingsSidebarCollapse } from "./use-settings-sidebar-collapse"

describe("useSettingsSidebarCollapse", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: null })
  })

  it("defaults to all groups expanded when unset", () => {
    const { result } = renderHook(() => useSettingsSidebarCollapse())
    expect(result.current.collapsedGroups).toEqual([])
    expect(result.current.isGroupCollapsed("ai")).toBe(false)
    expect(result.current.isGroupCollapsed("system")).toBe(false)
  })

  it("reflects persisted collapsed groups", () => {
    useSettingsStore.setState({
      settings: { settingsSidebarCollapsedGroups: ["data", "system"] } as never,
    })
    const { result } = renderHook(() => useSettingsSidebarCollapse())
    expect(result.current.isGroupCollapsed("data")).toBe(true)
    expect(result.current.isGroupCollapsed("system")).toBe(true)
    expect(result.current.isGroupCollapsed("ai")).toBe(false)
  })

  it("ignores unknown group ids from the stored blob", () => {
    useSettingsStore.setState({
      settings: { settingsSidebarCollapsedGroups: ["data", "bogus", 42] } as never,
    })
    const { result } = renderHook(() => useSettingsSidebarCollapse())
    expect(result.current.collapsedGroups).toEqual(["data"])
  })

  it("toggleGroup collapses an expanded group via save()", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ settings: {} as never, save })
    const { result } = renderHook(() => useSettingsSidebarCollapse())
    await act(async () => {
      await result.current.toggleGroup("extensions")
    })
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ settingsSidebarCollapsedGroups: ["extensions"] })
    )
  })

  it("toggleGroup expands a collapsed group via save()", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: { settingsSidebarCollapsedGroups: ["extensions", "data"] } as never,
      save,
    })
    const { result } = renderHook(() => useSettingsSidebarCollapse())
    await act(async () => {
      await result.current.toggleGroup("extensions")
    })
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ settingsSidebarCollapsedGroups: ["data"] })
    )
  })

  it("setGroupCollapsed is idempotent — no save when state already matches", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: { settingsSidebarCollapsedGroups: ["data"] } as never,
      save,
    })
    const { result } = renderHook(() => useSettingsSidebarCollapse())
    await act(async () => {
      await result.current.setGroupCollapsed("data", true)
      await result.current.setGroupCollapsed("ai", false)
    })
    expect(save).not.toHaveBeenCalled()
  })

  it("expandGroup removes the group from the collapsed set", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: { settingsSidebarCollapsedGroups: ["observability"] } as never,
      save,
    })
    const { result } = renderHook(() => useSettingsSidebarCollapse())
    await act(async () => {
      await result.current.expandGroup("observability")
    })
    await waitFor(() => expect(save).toHaveBeenCalledWith({ settingsSidebarCollapsedGroups: [] }))
  })
})

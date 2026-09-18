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
    expect(result.current.isGroupCollapsed("models")).toBe(false)
    expect(result.current.isGroupCollapsed("system")).toBe(false)
  })

  it("reflects persisted collapsed groups", () => {
    useSettingsStore.setState({
      settings: { settingsSidebarCollapsedGroups: ["privacy", "system"] } as never,
    })
    const { result } = renderHook(() => useSettingsSidebarCollapse())
    expect(result.current.isGroupCollapsed("privacy")).toBe(true)
    expect(result.current.isGroupCollapsed("system")).toBe(true)
    expect(result.current.isGroupCollapsed("models")).toBe(false)
  })

  it("ignores unknown group ids from the stored blob", () => {
    useSettingsStore.setState({
      settings: { settingsSidebarCollapsedGroups: ["privacy", "bogus", 42] } as never,
    })
    const { result } = renderHook(() => useSettingsSidebarCollapse())
    expect(result.current.collapsedGroups).toEqual(["privacy"])
  })

  it("toggleGroup collapses an expanded group via save()", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ settings: {} as never, save })
    const { result } = renderHook(() => useSettingsSidebarCollapse())
    await act(async () => {
      await result.current.toggleGroup("integrations")
    })
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ settingsSidebarCollapsedGroups: ["integrations"] })
    )
  })

  it("toggleGroup expands a collapsed group via save()", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: { settingsSidebarCollapsedGroups: ["integrations", "privacy"] } as never,
      save,
    })
    const { result } = renderHook(() => useSettingsSidebarCollapse())
    await act(async () => {
      await result.current.toggleGroup("integrations")
    })
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ settingsSidebarCollapsedGroups: ["privacy"] })
    )
  })

  it("setGroupCollapsed is idempotent — no save when state already matches", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: { settingsSidebarCollapsedGroups: ["privacy"] } as never,
      save,
    })
    const { result } = renderHook(() => useSettingsSidebarCollapse())
    await act(async () => {
      await result.current.setGroupCollapsed("privacy", true)
      await result.current.setGroupCollapsed("models", false)
    })
    expect(save).not.toHaveBeenCalled()
  })

  it("expandGroup removes the group from the collapsed set", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: { settingsSidebarCollapsedGroups: ["system"] } as never,
      save,
    })
    const { result } = renderHook(() => useSettingsSidebarCollapse())
    await act(async () => {
      await result.current.expandGroup("system")
    })
    await waitFor(() => expect(save).toHaveBeenCalledWith({ settingsSidebarCollapsedGroups: [] }))
  })
})

import { act, renderHook } from "@testing-library/react"

// Mock the settings store with a lightweight real Zustand store so the hook's
// selectors/subscriptions behave normally. Everything is built INSIDE the
// factory (require, not outer refs) to avoid the jest.mock TDZ trap. The pure
// resolver is the real implementation.
jest.mock("@/stores/settings", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { create } = require("zustand")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resolveSkillPanelPrefs } = require("@/lib/skills/preferences")
  const useSettingsStore = create(() => ({
    loaded: false,
    settings: null as unknown,
    setLastSkillView: jest.fn(async () => {}),
  }))
  return { __esModule: true, useSettingsStore, resolveSkillPanelPrefs }
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useSettingsStore } = require("@/stores/settings") as {
  useSettingsStore: {
    setState: (partial: unknown) => void
    getState: () => { setLastSkillView: jest.Mock }
  }
}
import { useSkillsStore } from "@/stores/skills"
import { useSkillPanelPrefs, useSkillPrefsHydration } from "./use-skill-prefs"

const RESET_FILTERS = {
  query: "",
  category: "all" as const,
  source: "all" as const,
  status: "all" as const,
  tag: null,
  sort: "name" as const,
}

beforeEach(() => {
  useSkillsStore.setState({ activeTab: "my-skills", filters: { ...RESET_FILTERS } })
  useSettingsStore.setState({ loaded: false, settings: null, setLastSkillView: jest.fn() })
})

describe("useSkillPanelPrefs", () => {
  it("resolves defaults over an empty settings value", () => {
    useSettingsStore.setState({ loaded: true, settings: {} })
    const { result } = renderHook(() => useSkillPanelPrefs())
    expect(result.current.density).toBe("comfortable")
    expect(result.current.showDescription).toBe(true)
    expect(result.current.autoEnableNew).toBe(true)
  })

  it("applies stored overrides", () => {
    useSettingsStore.setState({
      loaded: true,
      settings: { skillPanelPrefs: { density: "compact", viewMode: "grid" } },
    })
    const { result } = renderHook(() => useSkillPanelPrefs())
    expect(result.current.density).toBe("compact")
    expect(result.current.viewMode).toBe("grid")
  })
})

describe("useSkillPrefsHydration", () => {
  it("seeds the store from prefs once settings are loaded", () => {
    useSettingsStore.setState({
      loaded: true,
      settings: { skillPanelPrefs: { defaultTab: "browse", defaultSort: "updated" } },
    })
    renderHook(() => useSkillPrefsHydration())
    expect(useSkillsStore.getState().activeTab).toBe("browse")
    expect(useSkillsStore.getState().filters.sort).toBe("updated")
  })

  it("does not hydrate until settings are loaded", () => {
    useSettingsStore.setState({
      loaded: false,
      settings: { skillPanelPrefs: { defaultTab: "analytics" } },
    })
    const { rerender } = renderHook(() => useSkillPrefsHydration())
    expect(useSkillsStore.getState().activeTab).toBe("my-skills")
    act(() => useSettingsStore.setState({ loaded: true }))
    rerender()
    expect(useSkillsStore.getState().activeTab).toBe("analytics")
  })

  it("restores the last view when rememberLastView is on", () => {
    useSettingsStore.setState({
      loaded: true,
      settings: {
        skillPanelPrefs: { rememberLastView: true },
        lastSkillView: {
          tab: "analytics",
          sort: "usage",
          category: "development",
          source: "custom",
          status: "disabled",
          tag: "yaml",
        },
      },
    })
    renderHook(() => useSkillPrefsHydration())
    expect(useSkillsStore.getState().activeTab).toBe("analytics")
    expect(useSkillsStore.getState().filters).toMatchObject({
      sort: "usage",
      category: "development",
      source: "custom",
      status: "disabled",
      tag: "yaml",
    })
  })

  it("fills missing last-view fields from prefs defaults", () => {
    useSettingsStore.setState({
      loaded: true,
      settings: {
        // Partial snapshot → every field falls back to the resolved defaults.
        skillPanelPrefs: { rememberLastView: true, defaultTab: "editor", defaultSort: "usage" },
        lastSkillView: {},
      },
    })
    renderHook(() => useSkillPrefsHydration())
    expect(useSkillsStore.getState().activeTab).toBe("editor")
    expect(useSkillsStore.getState().filters).toMatchObject({
      sort: "usage",
      category: "all",
      source: "all",
      tag: null,
    })
  })

  it("persists a debounced snapshot when rememberLastView is on", () => {
    jest.useFakeTimers()
    const setLastSkillView = jest.fn()
    useSettingsStore.setState({
      loaded: true,
      settings: { skillPanelPrefs: { rememberLastView: true } },
      setLastSkillView,
    })
    renderHook(() => useSkillPrefsHydration())
    act(() => useSkillsStore.getState().setActiveTab("browse"))
    act(() => jest.advanceTimersByTime(600))
    expect(setLastSkillView).toHaveBeenCalledWith(expect.objectContaining({ tab: "browse" }))
    jest.useRealTimers()
  })

  it("debounces rapid changes into a single write with the final value", () => {
    jest.useFakeTimers()
    const setLastSkillView = jest.fn()
    useSettingsStore.setState({
      loaded: true,
      settings: { skillPanelPrefs: { rememberLastView: true } },
      setLastSkillView,
    })
    renderHook(() => useSkillPrefsHydration())
    act(() => {
      useSkillsStore.getState().setActiveTab("browse")
      useSkillsStore.getState().setActiveTab("editor")
    })
    act(() => jest.advanceTimersByTime(600))
    expect(setLastSkillView).toHaveBeenCalledTimes(1)
    expect(setLastSkillView).toHaveBeenCalledWith(expect.objectContaining({ tab: "editor" }))
    jest.useRealTimers()
  })

  it("skips the write when the tracked snapshot is unchanged", () => {
    jest.useFakeTimers()
    const setLastSkillView = jest.fn()
    useSettingsStore.setState({
      loaded: true,
      settings: { skillPanelPrefs: { rememberLastView: true } },
      setLastSkillView,
    })
    renderHook(() => useSkillPrefsHydration())
    // A store change that touches no tracked field (selection) → snapshot
    // equals the hydration snapshot → the write is deduped away.
    act(() => useSkillsStore.getState().toggleSelection("x"))
    act(() => jest.advanceTimersByTime(600))
    expect(setLastSkillView).not.toHaveBeenCalled()
    jest.useRealTimers()
  })

  it("does not persist when rememberLastView is off", () => {
    jest.useFakeTimers()
    const setLastSkillView = jest.fn()
    useSettingsStore.setState({
      loaded: true,
      settings: { skillPanelPrefs: { rememberLastView: false } },
      setLastSkillView,
    })
    renderHook(() => useSkillPrefsHydration())
    act(() => useSkillsStore.getState().setActiveTab("browse"))
    act(() => jest.advanceTimersByTime(600))
    expect(setLastSkillView).not.toHaveBeenCalled()
    jest.useRealTimers()
  })
})

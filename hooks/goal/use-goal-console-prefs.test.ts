import { renderHook, act, waitFor } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_GOAL_CONSOLE_PREFS } from "@/lib/goal/console-prefs"
import { useGoalConsolePrefs } from "./use-goal-console-prefs"

describe("useGoalConsolePrefs", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: null })
  })

  it("returns the hard defaults when unset", () => {
    const { result } = renderHook(() => useGoalConsolePrefs())
    expect(result.current.prefs).toEqual(DEFAULT_GOAL_CONSOLE_PREFS)
    expect(result.current.prefs.defaultTab).toBe("overview")
  })

  it("reflects persisted prefs, folding partials over defaults", () => {
    useSettingsStore.setState({
      settings: { goalConsolePrefs: { defaultTab: "analytics" } } as never,
    })
    const { result } = renderHook(() => useGoalConsolePrefs())
    expect(result.current.prefs.defaultTab).toBe("analytics")
    expect(result.current.prefs.openGoalsSort).toBe(DEFAULT_GOAL_CONSOLE_PREFS.openGoalsSort)
  })

  it("rewrites a retired default tab as the tab that absorbed it", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: { goalConsolePrefs: { defaultTab: "templates" } } as never,
      save,
    })
    const { result } = renderHook(() => useGoalConsolePrefs())
    expect(result.current.prefs.defaultTab).toBe("config")
    await act(async () => {
      await result.current.setPrefs({ openGoalsDir: "asc" })
    })
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        goalConsolePrefs: { defaultTab: "config", openGoalsSort: "created", openGoalsDir: "asc" },
      })
    )
  })

  it("merges a partial patch over current prefs before persisting", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: { goalConsolePrefs: { defaultTab: "history" } } as never,
      save,
    })
    const { result } = renderHook(() => useGoalConsolePrefs())
    await act(async () => {
      await result.current.setPrefs({ openGoalsSort: "tokens" })
    })
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        goalConsolePrefs: {
          defaultTab: "history",
          openGoalsSort: "tokens",
          openGoalsDir: "desc",
        },
      })
    )
  })
})

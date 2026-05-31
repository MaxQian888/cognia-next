import { renderHook, act, waitFor } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  useGoalConsoleView,
  isGoalConsoleView,
  DEFAULT_GOAL_CONSOLE_VIEW,
} from "./use-goal-console-view"

describe("isGoalConsoleView", () => {
  it("accepts grid and list", () => {
    expect(isGoalConsoleView("grid")).toBe(true)
    expect(isGoalConsoleView("list")).toBe(true)
  })
  it("rejects anything else", () => {
    expect(isGoalConsoleView("timeline")).toBe(false)
    expect(isGoalConsoleView("")).toBe(false)
  })
})

describe("useGoalConsoleView", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: null })
  })

  it("defaults to grid when unset", () => {
    const { result } = renderHook(() => useGoalConsoleView())
    expect(result.current.view).toBe(DEFAULT_GOAL_CONSOLE_VIEW)
    expect(result.current.view).toBe("grid")
  })

  it("reflects the persisted view", () => {
    useSettingsStore.setState({ settings: { goalConsoleView: "list" } as never })
    const { result } = renderHook(() => useGoalConsoleView())
    expect(result.current.view).toBe("list")
  })

  it("persists the view via save()", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ settings: {} as never, save })
    const { result } = renderHook(() => useGoalConsoleView())
    await act(async () => {
      await result.current.setView("list")
    })
    await waitFor(() => expect(save).toHaveBeenCalledWith({ goalConsoleView: "list" }))
  })
})

import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { GoalDefaultsForm } from "./goal-defaults-form"

const saveMock = jest.fn()
let mockedSettings: Record<string, unknown> | null = null

jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector?: (s: unknown) => unknown) => {
    const state = {
      settings: mockedSettings,
      save: saveMock,
    }
    return selector ? selector(state) : state
  }),
}))

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  saveMock.mockReset()
  saveMock.mockResolvedValue(undefined)
  mockedSettings = null
})

describe("GoalDefaultsForm", () => {
  it("renders all four numeric fields + the start-paused toggle", () => {
    render(<GoalDefaultsForm />)
    expect(screen.getByTestId("goal-defaults-max-turns")).toBeInTheDocument()
    expect(screen.getByTestId("goal-defaults-max-tokens")).toBeInTheDocument()
    expect(screen.getByTestId("goal-defaults-max-judge-failures")).toBeInTheDocument()
    expect(screen.getByTestId("goal-defaults-timeout")).toBeInTheDocument()
    expect(screen.getByTestId("goal-defaults-start-paused")).toBeInTheDocument()
  })

  it("save button starts disabled when no edits made", () => {
    render(<GoalDefaultsForm />)
    expect(screen.getByTestId("goal-defaults-save")).toBeDisabled()
  })

  it("editing a numeric field enables save and fires settings.save", async () => {
    render(<GoalDefaultsForm />)
    const turns = screen.getByTestId("goal-defaults-max-turns") as HTMLInputElement
    fireEvent.change(turns, { target: { value: "42" } })
    const save = screen.getByTestId("goal-defaults-save")
    expect(save).not.toBeDisabled()
    fireEvent.click(save)
    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ goals: expect.objectContaining({ maxTurns: 42 }) })
      )
    })
  })

  it("toggling start-paused enables save and persists the boolean", async () => {
    render(<GoalDefaultsForm />)
    const toggle = screen.getByTestId("goal-defaults-start-paused")
    fireEvent.click(toggle)
    fireEvent.click(screen.getByTestId("goal-defaults-save"))
    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ goals: expect.objectContaining({ startPaused: true }) })
      )
    })
  })

  it("editing a timeout (minutes) field converts to ms in the save payload", async () => {
    render(<GoalDefaultsForm />)
    const timeoutMin = screen.getByTestId("goal-defaults-timeout") as HTMLInputElement
    fireEvent.change(timeoutMin, { target: { value: "60" } })
    fireEvent.click(screen.getByTestId("goal-defaults-save"))
    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          goals: expect.objectContaining({ timeoutMs: 60 * 60_000 }),
        })
      )
    })
  })

  it("falls back to draft value when a numeric input is cleared", async () => {
    render(<GoalDefaultsForm />)
    const turns = screen.getByTestId("goal-defaults-max-turns") as HTMLInputElement
    const initial = turns.value
    fireEvent.change(turns, { target: { value: "" } })
    // The component coerces NaN back to the previous draft value.
    expect(turns.value).toBe(initial)
  })

  it("hydrates from a pre-populated settings.goals block on mount", () => {
    mockedSettings = { goals: { maxTurns: 7, maxTokens: 50_000, startPaused: true } }
    render(<GoalDefaultsForm />)
    const turns = screen.getByTestId("goal-defaults-max-turns") as HTMLInputElement
    expect(turns.value).toBe("7")
    const tokens = screen.getByTestId("goal-defaults-max-tokens") as HTMLInputElement
    expect(tokens.value).toBe("50000")
  })

  it("re-syncs draft when settings change externally between renders", async () => {
    const { rerender } = render(<GoalDefaultsForm />)
    expect((screen.getByTestId("goal-defaults-max-turns") as HTMLInputElement).value).toBe("20")
    // Simulate settings reload (e.g. backup restore) → store returns a
    // brand-new goals object identity.
    mockedSettings = { goals: { maxTurns: 99 } }
    rerender(<GoalDefaultsForm />)
    const turnsAfter = screen.getByTestId("goal-defaults-max-turns") as HTMLInputElement
    expect(turnsAfter.value).toBe("99")
  })
})

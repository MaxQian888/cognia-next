/** @jest-environment jsdom */
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react"

const saveMock = jest.fn<Promise<void>, [Record<string, unknown>]>()
let storeState: { settings: Record<string, unknown> | undefined; save: typeof saveMock }

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}))

import {
  armTraceDebugSession,
  disarmTraceDebugSession,
  getTraceDebugSession,
} from "@/lib/observability/debug-session"
import { UsageCostSection } from "./usage-cost-section"

beforeEach(() => {
  saveMock.mockReset().mockResolvedValue(undefined)
  storeState = { settings: { id: "singleton" }, save: saveMock }
  localStorage.clear()
})

afterEach(() => {
  disarmTraceDebugSession()
})

describe("spending limits", () => {
  it("renders empty inputs when no ceiling is configured", () => {
    render(<UsageCostSection />)
    expect(screen.getByLabelText("Daily limit (USD)")).toHaveValue(null)
    expect(screen.getByLabelText("Monthly limit (USD)")).toHaveValue(null)
  })

  it("shows the persisted ceilings", () => {
    storeState.settings = { id: "singleton", costBudget: { dailyUsd: 25, monthlyUsd: 400 } }
    render(<UsageCostSection />)
    expect(screen.getByLabelText("Daily limit (USD)")).toHaveValue(25)
    expect(screen.getByLabelText("Monthly limit (USD)")).toHaveValue(400)
  })

  it("saves a daily ceiling once, on blur, without dropping the monthly one", async () => {
    storeState.settings = { id: "singleton", costBudget: { monthlyUsd: 400 } }
    render(<UsageCostSection />)
    const daily = screen.getByLabelText("Daily limit (USD)")
    // Each keystroke used to be a save, and on a paired phone a queued host
    // update: typing "25" capped the day at $2 first.
    fireEvent.change(daily, { target: { value: "2" } })
    fireEvent.change(daily, { target: { value: "25" } })
    expect(saveMock).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.blur(daily)
    })
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(saveMock).toHaveBeenCalledWith({ costBudget: { monthlyUsd: 400, dailyUsd: 25 } })
  })

  it("clears a ceiling rather than persisting zero", async () => {
    storeState.settings = { id: "singleton", costBudget: { dailyUsd: 25 } }
    render(<UsageCostSection />)
    const daily = screen.getByLabelText("Daily limit (USD)")
    fireEvent.change(daily, { target: { value: "" } })
    await act(async () => {
      fireEvent.keyDown(daily, { key: "Enter" })
    })
    // A stored 0 would read as "no limit" downstream anyway; storing undefined
    // keeps the intent explicit.
    expect(saveMock).toHaveBeenCalledWith({ costBudget: { dailyUsd: undefined } })
  })

  it("ignores a negative ceiling", async () => {
    storeState.settings = { id: "singleton", costBudget: { monthlyUsd: 400 } }
    render(<UsageCostSection />)
    const monthly = screen.getByLabelText("Monthly limit (USD)")
    fireEvent.change(monthly, { target: { value: "-5" } })
    await act(async () => {
      fireEvent.blur(monthly)
    })
    expect(saveMock).toHaveBeenCalledWith({ costBudget: { monthlyUsd: undefined } })
  })

  it("does not write when no ceiling was set and none is typed", async () => {
    render(<UsageCostSection />)
    const monthly = screen.getByLabelText("Monthly limit (USD)")
    fireEvent.change(monthly, { target: { value: "-5" } })
    await act(async () => {
      fireEvent.blur(monthly)
    })
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("saves a per-provider ceiling once, on blur", async () => {
    storeState.settings = {
      id: "singleton",
      costBudget: { perProviderDailyUsd: { openai: 5 } },
    }
    render(<UsageCostSection />)
    const field = screen.getByLabelText(/openai/i, { selector: "#budget-openai-monthly" })
    fireEvent.change(field, { target: { value: "1" } })
    fireEvent.change(field, { target: { value: "120" } })
    expect(saveMock).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.blur(field)
    })
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(saveMock).toHaveBeenCalledWith({
      costBudget: {
        perProviderDailyUsd: { openai: 5 },
        perProviderMonthlyUsd: { openai: 120 },
      },
    })
  })

  it("saves a warn threshold once, on blur, as a ratio", async () => {
    render(<UsageCostSection />)
    const warn = screen
      .getByTestId("cost-budget-thresholds")
      .querySelector("#cost-budget-warn-at") as HTMLInputElement
    fireEvent.change(warn, { target: { value: "7" } })
    fireEvent.change(warn, { target: { value: "70" } })
    expect(saveMock).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.blur(warn)
    })
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(saveMock).toHaveBeenCalledWith({ costBudget: { warnAt: 0.7 } })
  })
})

describe("trace debug session", () => {
  it("shows no active badge when nothing is armed", () => {
    render(<UsageCostSection />)
    expect(screen.queryByTestId("debug-session-active")).not.toBeInTheDocument()
  })

  it("arms a bounded session and reflects it immediately", async () => {
    render(<UsageCostSection />)
    fireEvent.click(screen.getByText("15 min"))
    await waitFor(() => expect(screen.getByTestId("debug-session-active")).toBeInTheDocument())
    const session = getTraceDebugSession()
    // Bounded by construction — the old `captureContent` boolean had no expiry.
    expect(session?.expiresAt).toBeGreaterThan(Date.now())
    expect(session?.expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60_000)
  })

  it("disarms on demand", async () => {
    render(<UsageCostSection />)
    act(() => {
      armTraceDebugSession({})
    })
    await waitFor(() => expect(screen.getByTestId("debug-session-active")).toBeInTheDocument())
    fireEvent.click(screen.getByText("Stop now"))
    await waitFor(() =>
      expect(screen.queryByTestId("debug-session-active")).not.toBeInTheDocument()
    )
    expect(getTraceDebugSession()).toBeNull()
  })

  it("disables the stop button while nothing is armed", () => {
    render(<UsageCostSection />)
    expect(screen.getByText("Stop now").closest("button")).toBeDisabled()
  })
})

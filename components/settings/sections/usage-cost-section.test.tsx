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

  it("saves a daily ceiling without dropping the monthly one", () => {
    storeState.settings = { id: "singleton", costBudget: { monthlyUsd: 400 } }
    render(<UsageCostSection />)
    fireEvent.change(screen.getByLabelText("Daily limit (USD)"), {
      target: { value: "25" },
    })
    expect(saveMock).toHaveBeenCalledWith({ costBudget: { monthlyUsd: 400, dailyUsd: 25 } })
  })

  it("clears a ceiling rather than persisting zero", () => {
    storeState.settings = { id: "singleton", costBudget: { dailyUsd: 25 } }
    render(<UsageCostSection />)
    fireEvent.change(screen.getByLabelText("Daily limit (USD)"), {
      target: { value: "" },
    })
    // A stored 0 would read as "no limit" downstream anyway; storing undefined
    // keeps the intent explicit.
    expect(saveMock).toHaveBeenCalledWith({ costBudget: { dailyUsd: undefined } })
  })

  it("ignores a negative ceiling", () => {
    render(<UsageCostSection />)
    fireEvent.change(screen.getByLabelText("Monthly limit (USD)"), {
      target: { value: "-5" },
    })
    expect(saveMock).toHaveBeenCalledWith({ costBudget: { monthlyUsd: undefined } })
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

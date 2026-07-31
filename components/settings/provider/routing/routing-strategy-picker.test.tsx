import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RoutingStrategyPicker } from "./routing-strategy-picker"
import { DEFAULT_ROUTING_CONFIG } from "@cognia/provider-types/model-mapping"

const setRoutingConfig = jest.fn().mockResolvedValue(undefined)
const stateRef: { current: Record<string, unknown> } = {
  current: {
    settings: { routingConfig: { ...DEFAULT_ROUTING_CONFIG, strategy: "balanced" } },
    setRoutingConfig,
  },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(stateRef.current),
}))

beforeEach(() => setRoutingConfig.mockClear())

describe("RoutingStrategyPicker", () => {
  it("shows the active strategy's explanation", () => {
    render(<RoutingStrategyPicker />)
    // Appears in the trigger's selected item AND the helper paragraph.
    expect(
      screen.getAllByText("Weighted score: 40% success rate, 30% latency, 30% cost.").length
    ).toBeGreaterThan(0)
  })

  it("persists a strategy change", async () => {
    const user = userEvent.setup()
    render(<RoutingStrategyPicker />)
    await user.click(screen.getByRole("combobox", { name: "Strategy" }))
    await user.click(await screen.findByRole("option", { name: /Cost/ }))
    expect(setRoutingConfig).toHaveBeenCalledWith({ strategy: "cost" })
  })

  it("supports reliability, difficulty, and least-busy strategies", () => {
    const saved = stateRef.current
    try {
      stateRef.current = {
        settings: { routingConfig: { ...DEFAULT_ROUTING_CONFIG, strategy: "reliability" } },
        setRoutingConfig,
      }
      const { rerender } = render(<RoutingStrategyPicker />)
      expect(screen.getAllByText(/healthy samples/i).length).toBeGreaterThan(0)

      stateRef.current = {
        settings: { routingConfig: { ...DEFAULT_ROUTING_CONFIG, strategy: "difficulty" } },
        setRoutingConfig,
      }
      rerender(<RoutingStrategyPicker />)
      expect(screen.getAllByText(/strong model/i).length).toBeGreaterThan(0)

      stateRef.current = {
        settings: { routingConfig: { ...DEFAULT_ROUTING_CONFIG, strategy: "least-busy" } },
        setRoutingConfig,
      }
      rerender(<RoutingStrategyPicker />)
      expect(screen.getAllByText(/in-flight turns/i).length).toBeGreaterThan(0)
    } finally {
      stateRef.current = saved
    }
  })

  it("persists timeout and max-fallback edits, rejecting invalid values", () => {
    render(<RoutingStrategyPicker />)

    const timeout = screen.getByLabelText("Request timeout (ms)")
    // Empty value -> NaN -> must NOT persist.
    fireEvent.change(timeout, { target: { value: "" } })
    expect(setRoutingConfig).not.toHaveBeenCalled()
    fireEvent.change(timeout, { target: { value: "5000" } })
    expect(setRoutingConfig).toHaveBeenCalledWith({ requestTimeoutMs: 5000 })

    const attempts = screen.getByLabelText("Max fallback attempts")
    fireEvent.change(attempts, { target: { value: "5" } })
    expect(setRoutingConfig).toHaveBeenCalledWith({ maxFallbackAttempts: 5 })
  })
})

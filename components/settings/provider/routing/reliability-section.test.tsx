import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ReliabilitySection } from "./reliability-section"
import { DEFAULT_ROUTING_CONFIG } from "@cognia/provider-types/model-mapping"
import type { RoutingConfig } from "@cognia/provider-types/model-mapping"

const setRoutingConfig = jest.fn()
const stateRef: { current: { settings: { routingConfig: RoutingConfig } } } = {
  current: { settings: { routingConfig: { ...DEFAULT_ROUTING_CONFIG } } },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ ...stateRef.current, setRoutingConfig }),
}))

function withConfig(patch: Partial<RoutingConfig>) {
  stateRef.current = { settings: { routingConfig: { ...DEFAULT_ROUTING_CONFIG, ...patch } } }
}

beforeEach(() => {
  setRoutingConfig.mockClear()
  withConfig({})
})

describe("ReliabilitySection", () => {
  it("renders the default filter chain as ordered badges", () => {
    render(<ReliabilitySection />)
    const chain = screen.getByTestId("filter-chain")
    expect(chain).toHaveTextContent("Session affinity")
    expect(chain).toHaveTextContent("Circuit breaker")
    expect(chain).toHaveTextContent("Context window")
    expect(chain).toHaveTextContent("Rate limit")
    expect(chain).toHaveTextContent("Daily budget")
  })

  it("renders a configured custom chain, flagging unknown ids", () => {
    withConfig({ filterChain: ["circuit", "ghost-filter"] })
    render(<ReliabilitySection />)
    const chain = screen.getByTestId("filter-chain")
    expect(chain).toHaveTextContent("Circuit breaker")
    expect(chain).toHaveTextContent("ghost-filter")
    expect(chain).not.toHaveTextContent("Daily budget")
  })

  it("enabling the breaker persists circuitBreaker.enabled", async () => {
    const user = userEvent.setup()
    render(<ReliabilitySection />)
    await user.click(screen.getByRole("switch", { name: "Enable circuit breaker" }))
    expect(setRoutingConfig).toHaveBeenCalledWith({ circuitBreaker: { enabled: true } })
  })

  it("hides the tuning inputs while disabled", () => {
    render(<ReliabilitySection />)
    expect(screen.queryByLabelText("Failure threshold")).not.toBeInTheDocument()
  })

  it("switching to failure-rate mode seeds the rate fields", async () => {
    withConfig({ circuitBreaker: { enabled: true } })
    const user = userEvent.setup()
    render(<ReliabilitySection />)
    await user.click(screen.getByRole("combobox", { name: "Trip mode" }))
    await user.click(await screen.findByRole("option", { name: /Failure rate/ }))
    expect(setRoutingConfig).toHaveBeenCalledWith({
      circuitBreaker: { enabled: true, failureRateThreshold: 0.5, minRequestVolume: 10 },
    })
  })

  it("switching back to absolute mode removes the rate fields", async () => {
    withConfig({
      circuitBreaker: { enabled: true, failureRateThreshold: 0.5, minRequestVolume: 10 },
    })
    const user = userEvent.setup()
    render(<ReliabilitySection />)
    await user.click(screen.getByRole("combobox", { name: "Trip mode" }))
    await user.click(await screen.findByRole("option", { name: /Absolute count/ }))
    expect(setRoutingConfig).toHaveBeenCalledWith({ circuitBreaker: { enabled: true } })
  })

  it("failure-rate mode shows the percent + volume inputs and persists edits", () => {
    withConfig({
      circuitBreaker: { enabled: true, failureRateThreshold: 0.5, minRequestVolume: 10 },
    })
    render(<ReliabilitySection />)
    const pct = screen.getByLabelText("Failure rate (%)")
    expect(pct).toHaveValue(50)
    // Single change event with the full value (the mocked store never
    // re-renders, so per-keystroke typing would accumulate digits).
    fireEvent.change(pct, { target: { value: "75" } })
    expect(setRoutingConfig).toHaveBeenLastCalledWith({
      circuitBreaker: expect.objectContaining({ failureRateThreshold: 0.75 }),
    })
    expect(screen.getByLabelText("Min request volume")).toHaveValue(10)
  })

  it("persists threshold and cooldown edits", () => {
    withConfig({ circuitBreaker: { enabled: true } })
    render(<ReliabilitySection />)
    const threshold = screen.getByLabelText("Failure threshold")
    expect(threshold).toHaveValue(5) // DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold
    fireEvent.change(threshold, { target: { value: "3" } })
    expect(setRoutingConfig).toHaveBeenLastCalledWith({
      circuitBreaker: expect.objectContaining({ failureThreshold: 3 }),
    })
    fireEvent.change(screen.getByLabelText("Cooldown (ms)"), { target: { value: "60000" } })
    expect(setRoutingConfig).toHaveBeenLastCalledWith({
      circuitBreaker: expect.objectContaining({ cooldownMs: 60000 }),
    })
    fireEvent.change(screen.getByLabelText("Max cooldown (ms)"), { target: { value: "120000" } })
    expect(setRoutingConfig).toHaveBeenLastCalledWith({
      circuitBreaker: expect.objectContaining({ maxCooldownMs: 120000 }),
    })
  })
})

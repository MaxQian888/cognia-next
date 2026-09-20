import { act, render, screen, fireEvent } from "@testing-library/react"
import {
  getProviderHealth,
  resetProviderHealth,
} from "@cognia/web-search/provider-health"

const resetStoreMock = jest.fn()

let settings: {
  searchProviders?: Record<
    string,
    { providerId: string; apiKey: string; enabled: boolean; priority: number }
  >
  searchProviderHealth?: { enabled: boolean; failureThreshold: number; cooldownMs: number }
} = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: Record<string, unknown>) => T) =>
    selector({ settings, resetSearchProviderHealth: resetStoreMock }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const mockLogInfo = jest.fn()
jest.mock("@cognia/logging", () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => mockLogInfo(...args),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
  }),
}))

import { SearchProviderHealthPanel } from "./search-provider-health-panel"

function configuredProviders() {
  return {
    searchProviders: {
      tavily: { providerId: "tavily", apiKey: "tvly-key", enabled: true, priority: 1 },
      exa: { providerId: "exa", apiKey: "exa-key", enabled: true, priority: 2 },
      // Enabled but missing its key → not "configured", excluded from rows.
      brave: { providerId: "brave", apiKey: "", enabled: true, priority: 3 },
      // Configured but disabled → excluded until it has traffic.
      serper: { providerId: "serper", apiKey: "serper-key", enabled: false, priority: 4 },
    },
  }
}

beforeEach(() => {
  resetProviderHealth()
  resetStoreMock.mockReset()
  mockLogInfo.mockReset()
  settings = configuredProviders()
})

describe("SearchProviderHealthPanel", () => {
  it("shows the empty state when nothing is configured and nothing has traffic", () => {
    settings = {}
    render(<SearchProviderHealthPanel />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("lists enabled+configured providers with an unknown status before traffic", () => {
    render(<SearchProviderHealthPanel />)
    expect(screen.getByText("Tavily")).toBeInTheDocument()
    expect(screen.getByText("Exa")).toBeInTheDocument()
    // brave lacks a key; serper is disabled → neither renders.
    expect(screen.queryByText("Brave Search")).not.toBeInTheDocument()
    expect(screen.queryByText("Serper")).not.toBeInTheDocument()
    expect(screen.getAllByText("status.unknown")).toHaveLength(2)
    expect(screen.getAllByText("circuitClosed")).toHaveLength(2)
  })

  it("renders counters, success rate, and avg latency from the breaker", () => {
    const health = getProviderHealth()
    health.recordResult("tavily", true, 100)
    health.recordResult("tavily", true, 200)
    health.recordResult("tavily", false)
    render(<SearchProviderHealthPanel />)
    // 2/3 ok → 67%, avg latency 150ms.
    expect(screen.getByText('successRate:{"percent":67}')).toBeInTheDocument()
    expect(screen.getByText('avgLatency:{"ms":150}')).toBeInTheDocument()
    expect(screen.getByText('counters:{"ok":2,"failed":1}')).toBeInTheDocument()
  })

  it("shows a degraded badge when success rate drops below half", () => {
    const health = getProviderHealth()
    health.recordResult("exa", false)
    health.recordResult("exa", false)
    render(<SearchProviderHealthPanel />)
    expect(screen.getByText("status.degraded")).toBeInTheDocument()
  })

  it("marks a tripped circuit open with remaining cooldown seconds", () => {
    const health = getProviderHealth()
    for (let i = 0; i < 3; i++) health.recordResult("tavily", false)
    render(<SearchProviderHealthPanel />)
    expect(screen.getByText("status.unhealthy")).toBeInTheDocument()
    expect(screen.getByText('circuitOpen:{"seconds":30}')).toBeInTheDocument()
  })

  it("reshapes rows when settings change without waiting for a poll", () => {
    const { rerender } = render(<SearchProviderHealthPanel />)
    expect(screen.getByText("Tavily")).toBeInTheDocument()
    expect(screen.queryByText("Serper")).not.toBeInTheDocument()
    // Disable tavily, enable serper — no timer advance needed.
    settings = {
      searchProviders: {
        ...configuredProviders().searchProviders,
        tavily: { providerId: "tavily", apiKey: "tvly-key", enabled: false, priority: 1 },
        serper: { providerId: "serper", apiKey: "serper-key", enabled: true, priority: 4 },
      },
    }
    rerender(<SearchProviderHealthPanel />)
    expect(screen.queryByText("Tavily")).not.toBeInTheDocument()
    expect(screen.getByText("Serper")).toBeInTheDocument()
  })

  it("includes an unconfigured provider once it has traffic", () => {
    const health = getProviderHealth()
    health.recordResult("brave", false)
    render(<SearchProviderHealthPanel />)
    expect(screen.getByText("Brave Search")).toBeInTheDocument()
  })

  it("polls every second while a circuit is open, otherwise every five", () => {
    jest.useFakeTimers()
    try {
      const health = getProviderHealth()
      render(<SearchProviderHealthPanel />)
      // All closed → 5s cadence: a failure recorded now shows after 5s.
      health.recordResult("tavily", false)
      act(() => jest.advanceTimersByTime(4999))
      expect(screen.queryByText('counters:{"ok":0,"failed":1}')).not.toBeInTheDocument()
      act(() => jest.advanceTimersByTime(1))
      expect(screen.getByText('counters:{"ok":0,"failed":1}')).toBeInTheDocument()

      // Trip the breaker (threshold 3). The armed interval is still on the 5s
      // cadence — the open state surfaces at the next tick, which then re-arms
      // at 1s while the circuit stays open.
      health.recordResult("tavily", false)
      health.recordResult("tavily", false)
      act(() => jest.advanceTimersByTime(5000))
      expect(screen.getByText("status.unhealthy")).toBeInTheDocument()
      // Now on the fast cadence: the countdown re-renders every second
      // (opened at fake-t=5s; at t=11s the remaining cooldown shows 24s).
      act(() => jest.advanceTimersByTime(1000))
      expect(screen.getByText('circuitOpen:{"seconds":24}')).toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
  })

  it("per-row Reset clears the breaker and re-snapshots immediately", () => {
    const health = getProviderHealth()
    health.recordResult("tavily", false)
    render(<SearchProviderHealthPanel />)
    fireEvent.click(screen.getAllByText("reset")[0])
    expect(resetStoreMock).toHaveBeenCalledWith("tavily")
    expect(mockLogInfo).toHaveBeenCalledWith("provider_health_reset", { providerId: "tavily" })
  })

  it("Reset all clears every row", () => {
    render(<SearchProviderHealthPanel />)
    fireEvent.click(screen.getByText("resetAll"))
    expect(resetStoreMock).toHaveBeenCalledWith(undefined)
    expect(mockLogInfo).toHaveBeenCalledWith("provider_health_reset_all")
  })

  it("shows the muted breaker-disabled line when the setting is off", () => {
    settings = {
      ...configuredProviders(),
      searchProviderHealth: { enabled: false, failureThreshold: 3, cooldownMs: 30_000 },
    }
    render(<SearchProviderHealthPanel />)
    expect(screen.getByText("breakerDisabled")).toBeInTheDocument()
  })
})

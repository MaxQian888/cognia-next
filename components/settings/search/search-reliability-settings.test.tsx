import { render, screen, fireEvent } from "@testing-library/react"

const setHealthMock = jest.fn()

let settings: {
  searchProviderHealth?: {
    enabled: boolean
    failureThreshold: number
    cooldownMs: number
  }
} = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: {
      settings: typeof settings
      setSearchProviderHealthSettings: typeof setHealthMock
    }) => T
  ) =>
    selector({
      settings,
      setSearchProviderHealthSettings: setHealthMock,
    }),
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

jest.mock("@/components/ui/slider", () => ({
  Slider: ({
    value,
    onValueChange,
    onValueCommit,
    min,
    max,
  }: {
    value: number[]
    onValueChange: (v: number[]) => void
    onValueCommit?: (v: number[]) => void
    min?: number
    max?: number
  }) => (
    <input
      role="slider"
      type="number"
      aria-valuenow={value?.[0] ?? 0}
      aria-valuemin={min}
      aria-valuemax={max}
      value={value?.[0] ?? 0}
      onChange={(e) => {
        const v = [Number(e.target.value)]
        onValueChange(v)
        onValueCommit?.(v)
      }}
    />
  ),
}))

import { SearchReliabilitySettings } from "./search-reliability-settings"

beforeEach(() => {
  setHealthMock.mockReset()
  mockLogInfo.mockReset()
  settings = {}
})

describe("SearchReliabilitySettings", () => {
  it("renders the breaker toggle and falls back to defaults", () => {
    render(<SearchReliabilitySettings />)
    expect(screen.getByText("title")).toBeInTheDocument()
    // Default config: enabled, threshold 3, cooldown 30s.
    expect(screen.getByRole("switch")).toBeChecked()
    const sliders = screen.getAllByRole("slider")
    expect(sliders[0]).toHaveAttribute("aria-valuenow", "3")
    expect(sliders[1]).toHaveAttribute("aria-valuenow", "30")
  })

  it("hides the sliders when the breaker is disabled", () => {
    settings = { searchProviderHealth: { enabled: false, failureThreshold: 3, cooldownMs: 30_000 } }
    render(<SearchReliabilitySettings />)
    expect(screen.queryByRole("slider")).not.toBeInTheDocument()
  })

  it("persists the toggle through setSearchProviderHealthSettings", () => {
    render(<SearchReliabilitySettings />)
    fireEvent.click(screen.getByRole("switch"))
    expect(setHealthMock).toHaveBeenCalledWith({ enabled: false })
    expect(mockLogInfo).toHaveBeenCalledWith("provider_health_enabled_changed", { enabled: false })
  })

  it("writes failureThreshold as an integer within the published limits", () => {
    render(<SearchReliabilitySettings />)
    const [threshold] = screen.getAllByRole("slider")
    expect(threshold).toHaveAttribute("aria-valuemin", "1")
    expect(threshold).toHaveAttribute("aria-valuemax", "10")
    fireEvent.change(threshold, { target: { value: "7" } })
    expect(setHealthMock).toHaveBeenCalledWith({ failureThreshold: 7 })
    expect(mockLogInfo).toHaveBeenCalledWith("provider_health_threshold_changed", {
      failureThreshold: 7,
    })
  })

  it("writes cooldownMs in milliseconds from a seconds slider", () => {
    render(<SearchReliabilitySettings />)
    const [, cooldown] = screen.getAllByRole("slider")
    expect(cooldown).toHaveAttribute("aria-valuemin", "5")
    expect(cooldown).toHaveAttribute("aria-valuemax", "600")
    fireEvent.change(cooldown, { target: { value: "120" } })
    expect(setHealthMock).toHaveBeenCalledWith({ cooldownMs: 120_000 })
    expect(mockLogInfo).toHaveBeenCalledWith("provider_health_cooldown_changed", {
      cooldownMs: 120_000,
    })
  })

  it("normalizes a partial persisted row before rendering", () => {
    settings = {
      searchProviderHealth: { enabled: true, failureThreshold: 99, cooldownMs: 1 },
    }
    render(<SearchReliabilitySettings />)
    const sliders = screen.getAllByRole("slider")
    // Clamped to the published limits on the way in.
    expect(sliders[0]).toHaveAttribute("aria-valuenow", "10")
    expect(sliders[1]).toHaveAttribute("aria-valuenow", "5")
  })
})

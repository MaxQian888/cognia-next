import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RoutingPresetCards } from "./routing-preset-cards"
import { DEFAULT_ROUTING_PRESETS_STATE } from "@/types/provider/routing-presets"

const revertRoutingPreset = jest.fn().mockResolvedValue(undefined)
const activateRoutingPreset = jest.fn().mockResolvedValue(undefined)
const stateRef: { current: Record<string, unknown> } = { current: {} }

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(stateRef.current),
}))

function setPresetState(over: Partial<typeof DEFAULT_ROUTING_PRESETS_STATE> = {}) {
  stateRef.current = {
    settings: {
      routingPresets: { ...DEFAULT_ROUTING_PRESETS_STATE, ...over },
      providerSettings: { openai: { providerId: "openai", enabled: true } },
      customProviders: [],
    },
    revertRoutingPreset,
    activateRoutingPreset,
  }
}

beforeEach(() => {
  revertRoutingPreset.mockClear()
  activateRoutingPreset.mockClear()
})

describe("RoutingPresetCards", () => {
  it("renders the three built-in preset cards", () => {
    setPresetState()
    render(<RoutingPresetCards />)
    expect(screen.getByTestId("preset-card-budget")).toBeInTheDocument()
    expect(screen.getByTestId("preset-card-performance")).toBeInTheDocument()
    expect(screen.getByTestId("preset-card-reliability")).toBeInTheDocument()
  })

  it("marks the active preset and offers revert when a snapshot exists", async () => {
    const user = userEvent.setup()
    setPresetState({
      activePresetId: "preset-budget",
      preActivationSnapshot: {
        strategy: "balanced",
        mappings: [],
        routingConfig: {
          strategy: "balanced",
          allowPerRequestOverride: true,
          providerConstraints: [],
          requestTimeoutMs: 30000,
          maxFallbackAttempts: 3,
        },
        timestamp: 1,
      },
    })
    render(<RoutingPresetCards />)
    expect(screen.getByText("Active")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Revert last preset/ }))
    expect(revertRoutingPreset).toHaveBeenCalled()
  })

  it("hides revert without a snapshot and opens the preview dialog", async () => {
    const user = userEvent.setup()
    setPresetState()
    render(<RoutingPresetCards />)
    expect(screen.queryByRole("button", { name: /Revert last preset/ })).not.toBeInTheDocument()

    await user.click(screen.getAllByRole("button", { name: "Preview & Apply" })[0])
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
  })
})

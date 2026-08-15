import { render, screen } from "@testing-library/react"
import { RoutingConfigPanel } from "./routing-config-panel"
import { DEFAULT_ROUTING_CONFIG } from "@cognia/provider-types/model-mapping"

const stateRef: { current: Record<string, unknown> } = {
  current: {
    settings: {
      modelMappings: [],
      routingConfig: DEFAULT_ROUTING_CONFIG,
      routingPresets: undefined,
      providerSettings: {},
      customProviders: [],
    },
    setRoutingConfig: jest.fn(),
    upsertModelMapping: jest.fn(),
    removeModelMapping: jest.fn(),
    activateRoutingPreset: jest.fn(),
    revertRoutingPreset: jest.fn(),
  },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(stateRef.current),
}))

describe("RoutingConfigPanel", () => {
  it("renders the global banner and all sections", () => {
    render(<RoutingConfigPanel />)
    expect(screen.getByText(/Routing configuration is global/)).toBeInTheDocument()
    expect(screen.getByText("Quick Presets")).toBeInTheDocument()
    expect(screen.getByText("Routing Strategy")).toBeInTheDocument()
    expect(screen.getByText("Model Aliases")).toBeInTheDocument()
    expect(screen.getByText("Provider Constraints")).toBeInTheDocument()
    // "Reliability" also appears as a preset card name — assert the section
    // exists via its unique description instead.
    expect(
      screen.getByText(/Circuit-breaker behavior and the pre-call filter chain/)
    ).toBeInTheDocument()
    expect(screen.getByText("Routing Workbench")).toBeInTheDocument()
  })

  it("mounts the difficulty-routing section so the picker's difficulty strategy is configurable", () => {
    render(<RoutingConfigPanel />)
    // The strategy picker lists "difficulty"; its model pair used to have no UI.
    expect(screen.getByText("Difficulty Routing")).toBeInTheDocument()
  })
})

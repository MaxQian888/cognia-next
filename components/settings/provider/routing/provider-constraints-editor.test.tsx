import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProviderConstraintsEditor } from "./provider-constraints-editor"
import {
  DEFAULT_ROUTING_CONFIG,
  type ProviderConstraint,
} from "@cognia/provider-types/model-mapping"

const setRoutingConfig = jest.fn().mockResolvedValue(undefined)
const stateRef: { current: Record<string, unknown> } = { current: {} }

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(stateRef.current),
}))

function setConstraints(providerConstraints: ProviderConstraint[]) {
  stateRef.current = {
    settings: {
      routingConfig: { ...DEFAULT_ROUTING_CONFIG, providerConstraints },
      providerSettings: {
        openai: { providerId: "openai", enabled: true, enabledModels: ["gpt-4o-mini"] },
      },
      customProviders: [],
    },
    setRoutingConfig,
  }
}

beforeEach(() => setRoutingConfig.mockClear())

describe("ProviderConstraintsEditor", () => {
  it("shows an empty hint when no constraints exist", () => {
    setConstraints([])
    render(<ProviderConstraintsEditor />)
    expect(screen.getByText("No constraints configured.")).toBeInTheDocument()
  })

  it("adds a constraint for the first unconstrained provider", async () => {
    const user = userEvent.setup()
    setConstraints([])
    render(<ProviderConstraintsEditor />)
    await user.click(screen.getByRole("button", { name: /Add constraint/ }))
    expect(setRoutingConfig).toHaveBeenCalledWith({
      providerConstraints: [{ providerId: "anthropic", enabled: true }],
    })
  })

  it("edits the daily budget on an existing row", async () => {
    const user = userEvent.setup()
    setConstraints([{ providerId: "openai", enabled: true }])
    render(<ProviderConstraintsEditor />)
    await user.type(screen.getByLabelText("Daily budget ($)"), "5")
    expect(setRoutingConfig).toHaveBeenCalledWith({
      providerConstraints: [{ providerId: "openai", enabled: true, dailyCostBudget: 5 }],
    })
  })

  it("edits rpm/tpm ceilings", async () => {
    const user = userEvent.setup()
    setConstraints([{ providerId: "openai", enabled: true }])
    render(<ProviderConstraintsEditor />)
    await user.type(screen.getByLabelText("Max req/min"), "9")
    expect(setRoutingConfig).toHaveBeenCalledWith({
      providerConstraints: [{ providerId: "openai", enabled: true, maxRequestsPerMinute: 9 }],
    })
    await user.type(screen.getByLabelText("Max tokens/min"), "7")
    expect(setRoutingConfig).toHaveBeenCalledWith({
      providerConstraints: [{ providerId: "openai", enabled: true, maxTokensPerMinute: 7 }],
    })
  })

  it("toggles and removes a constraint", async () => {
    const user = userEvent.setup()
    setConstraints([{ providerId: "openai", enabled: true }])
    render(<ProviderConstraintsEditor />)
    await user.click(screen.getByLabelText("Constraint enabled"))
    expect(setRoutingConfig).toHaveBeenCalledWith({
      providerConstraints: [{ providerId: "openai", enabled: false }],
    })
    await user.click(screen.getByRole("button", { name: "Remove constraint" }))
    expect(setRoutingConfig).toHaveBeenCalledWith({ providerConstraints: [] })
  })

  it("clearing a numeric field maps it back to undefined", async () => {
    const user = userEvent.setup()
    setConstraints([{ providerId: "openai", enabled: true, dailyCostBudget: 5 }])
    render(<ProviderConstraintsEditor />)
    await user.clear(screen.getByLabelText("Daily budget ($)"))
    expect(setRoutingConfig).toHaveBeenCalledWith({
      providerConstraints: [{ providerId: "openai", enabled: true, dailyCostBudget: undefined }],
    })
  })

  it("changes the constrained provider through the select", async () => {
    const user = userEvent.setup()
    setConstraints([{ providerId: "openai", enabled: true }])
    render(<ProviderConstraintsEditor />)
    await user.click(screen.getByRole("combobox", { name: "Provider" }))
    await user.click(await screen.findByRole("option", { name: "anthropic" }))
    expect(setRoutingConfig).toHaveBeenCalledWith({
      providerConstraints: [{ providerId: "anthropic", enabled: true }],
    })
  })

  it("add picks the first provider not already constrained", async () => {
    const user = userEvent.setup()
    setConstraints([{ providerId: "anthropic", enabled: true }])
    render(<ProviderConstraintsEditor />)
    await user.click(screen.getByRole("button", { name: /Add constraint/ }))
    expect(setRoutingConfig).toHaveBeenCalledWith({
      providerConstraints: [
        { providerId: "anthropic", enabled: true },
        { providerId: "openai", enabled: true },
      ],
    })
  })
})

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RoutingPresetPreviewDialog } from "./routing-preset-preview-dialog"
import { BUDGET_PRESET } from "@cognia/provider-routing/built-in-presets"

const activateRoutingPreset = jest.fn().mockResolvedValue(undefined)
const stateRef: { current: Record<string, unknown> } = { current: {} }

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(stateRef.current),
}))

function setProviders(providerSettings: Record<string, unknown>) {
  stateRef.current = {
    settings: { providerSettings, customProviders: [] },
    activateRoutingPreset,
  }
}

beforeEach(() => activateRoutingPreset.mockClear())

describe("RoutingPresetPreviewDialog", () => {
  it("shows the adapted chains and applies with merge by default", async () => {
    const user = userEvent.setup()
    setProviders({ deepseek: { providerId: "deepseek", enabled: true } })
    const onOpenChange = jest.fn()
    render(<RoutingPresetPreviewDialog preset={BUDGET_PRESET} open onOpenChange={onOpenChange} />)

    // Adapted chain only contains enabled providers (deepseek here; groq is
    // not enabled so its entries vanish).
    expect(screen.queryByText(/groq:/)).not.toBeInTheDocument()
    expect(screen.getAllByText(/deepseek:/).length).toBeGreaterThan(0)

    await user.click(screen.getByRole("button", { name: "Apply preset" }))
    expect(activateRoutingPreset).toHaveBeenCalledWith("budget", "merge")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("applies with overwrite when selected", async () => {
    const user = userEvent.setup()
    setProviders({ deepseek: { providerId: "deepseek", enabled: true } })
    render(<RoutingPresetPreviewDialog preset={BUDGET_PRESET} open onOpenChange={jest.fn()} />)

    await user.click(screen.getByLabelText(/Overwrite/))
    await user.click(screen.getByRole("button", { name: "Apply preset" }))
    expect(activateRoutingPreset).toHaveBeenCalledWith("budget", "overwrite")
  })

  it("disables apply when no preset provider is enabled", () => {
    // Explicitly disable anthropic too — otherwise it's always considered on.
    setProviders({ anthropic: { providerId: "anthropic", enabled: false } })
    render(<RoutingPresetPreviewDialog preset={BUDGET_PRESET} open onOpenChange={jest.fn()} />)
    expect(screen.getByText(/None of this preset's providers are enabled/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Apply preset" })).toBeDisabled()
  })

  it("renders nothing without a preset", () => {
    setProviders({})
    const { container } = render(
      <RoutingPresetPreviewDialog preset={null} open onOpenChange={jest.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})

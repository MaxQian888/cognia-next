import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProviderModelCombobox } from "./provider-model-combobox"

const stateRef: { current: Record<string, unknown> } = {
  current: {
    settings: {
      providerSettings: {
        openai: {
          providerId: "openai",
          enabled: true,
          defaultModel: "gpt-4o-mini",
          enabledModels: ["gpt-4o-mini", "gpt-4.1"],
        },
      },
      customProviders: [],
    },
  },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(stateRef.current),
}))

describe("ProviderModelCombobox", () => {
  it("shows the placeholder when nothing is selected", () => {
    render(<ProviderModelCombobox onSelect={jest.fn()} />)
    expect(screen.getByText("Pick provider / model")).toBeInTheDocument()
  })

  it("shows the current provider/model when selected", () => {
    render(<ProviderModelCombobox providerId="openai" modelId="gpt-4o-mini" onSelect={jest.fn()} />)
    expect(screen.getByText("openai / gpt-4o-mini")).toBeInTheDocument()
  })

  it("opens the list and fires onSelect with the picked pair", async () => {
    const onSelect = jest.fn()
    const user = userEvent.setup()
    render(<ProviderModelCombobox onSelect={onSelect} />)

    await user.click(screen.getByRole("button", { name: "Provider and model" }))
    await user.click(await screen.findByText("gpt-4.1"))

    expect(onSelect).toHaveBeenCalledWith("openai", "gpt-4.1")
  })
})

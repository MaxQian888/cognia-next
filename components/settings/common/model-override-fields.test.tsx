import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { renderHook } from "@testing-library/react"
import { ModelOverrideFields, useUtilityProviderOptions } from "./model-override-fields"

const stateRef: { current: Record<string, unknown> } = {
  current: {
    settings: {
      providerSettings: { openai: { providerId: "openai", enabled: true } },
      customProviders: [{ id: "my-local", name: "My Local" }],
    },
  },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(stateRef.current),
}))

const labels = { provider: "Provider", model: "Model", useDefault: "Use chat default" }

describe("useUtilityProviderOptions", () => {
  it("merges configured providers and custom providers", () => {
    const { result } = renderHook(() => useUtilityProviderOptions())
    expect(result.current).toEqual([
      { id: "openai", name: "openai" },
      { id: "my-local", name: "My Local" },
    ])
  })
})

describe("ModelOverrideFields", () => {
  it("selects a provider override and clears it back to default", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(
      <ModelOverrideFields
        value={undefined}
        providers={[{ id: "openai", name: "openai" }]}
        onChange={onChange}
        labels={labels}
      />
    )
    await user.click(screen.getByRole("combobox", { name: "Provider" }))
    await user.click(await screen.findByRole("option", { name: "openai" }))
    expect(onChange).toHaveBeenCalledWith({ providerOverride: "openai" })
  })

  it("propagates model edits, mapping empty back to undefined", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(
      <ModelOverrideFields
        value={{ enabled: true, model: "" }}
        providers={[]}
        onChange={onChange}
        labels={labels}
      />
    )
    await user.type(screen.getByLabelText("Model"), "x")
    expect(onChange).toHaveBeenCalledWith({ model: "x" })
  })
})

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { renderHook } from "@testing-library/react"
import { ModelOverrideFields, useUtilityProviderOptions } from "./model-override-fields"

const baseSettings = {
  defaultProvider: "openai",
  providerSettings: { openai: { providerId: "openai", enabled: true } },
  customProviders: [{ id: "my-local", name: "My Local" }],
}

const stateRef: { current: { settings: Record<string, unknown> } } = {
  current: { settings: { ...baseSettings } },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(stateRef.current),
}))

// Deterministic model catalog so the model select never depends on the real
// built-in PROVIDERS registry — that derivation is covered by
// lib/ai/model-options.test.ts.
jest.mock("@/lib/ai/model-options", () => ({
  collectModelOptions: () => [
    { providerId: "openai", providerName: "openai", modelId: "gpt-4o", modelName: "GPT-4o" },
    {
      providerId: "openai",
      providerName: "openai",
      modelId: "gpt-4o-mini",
      modelName: "GPT-4o mini",
    },
    {
      providerId: "anthropic",
      providerName: "anthropic",
      modelId: "claude-x",
      modelName: "Claude X",
    },
  ],
}))

const labels = { provider: "Provider", model: "Model", useDefault: "Use chat default" }
const openaiOnly = [{ id: "openai", name: "openai" }]

beforeEach(() => {
  stateRef.current = { settings: { ...baseSettings } }
})

describe("useUtilityProviderOptions", () => {
  it("merges configured providers and custom providers", () => {
    const { result } = renderHook(() => useUtilityProviderOptions())
    expect(result.current).toEqual([
      { id: "openai", name: "openai" },
      { id: "my-local", name: "My Local" },
    ])
  })
})

describe("ModelOverrideFields — provider select", () => {
  it("selects a provider override and clears it back to default", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(
      <ModelOverrideFields
        value={undefined}
        providers={openaiOnly}
        onChange={onChange}
        labels={labels}
      />
    )
    await user.click(screen.getByRole("combobox", { name: "Provider" }))
    await user.click(await screen.findByRole("option", { name: "openai" }))
    expect(onChange).toHaveBeenCalledWith({ providerOverride: "openai" })
  })

  it("clears an explicit provider override back to the chat default", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(
      <ModelOverrideFields
        value={{ enabled: true, providerOverride: "openai" }}
        providers={openaiOnly}
        onChange={onChange}
        labels={labels}
      />
    )
    await user.click(screen.getByRole("combobox", { name: "Provider" }))
    await user.click(await screen.findByRole("option", { name: "Use chat default" }))
    expect(onChange).toHaveBeenCalledWith({ providerOverride: undefined })
  })
})

describe("ModelOverrideFields — model select (synced with provider)", () => {
  it("lists only the selected provider's models", async () => {
    const user = userEvent.setup()
    render(
      <ModelOverrideFields
        value={{ providerOverride: "openai" }}
        providers={openaiOnly}
        onChange={jest.fn()}
        labels={labels}
      />
    )
    await user.click(screen.getByRole("combobox", { name: "Model" }))
    expect(await screen.findByRole("option", { name: "GPT-4o" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "GPT-4o mini" })).toBeInTheDocument()
    // anthropic model must not leak into an openai-scoped list.
    expect(screen.queryByRole("option", { name: "Claude X" })).not.toBeInTheDocument()
  })

  it("defaults the model list to the app default provider when no override is set", async () => {
    const user = userEvent.setup()
    render(
      <ModelOverrideFields
        value={undefined}
        providers={openaiOnly}
        onChange={jest.fn()}
        labels={labels}
      />
    )
    await user.click(screen.getByRole("combobox", { name: "Model" }))
    expect(await screen.findByRole("option", { name: "GPT-4o" })).toBeInTheDocument()
  })

  it("falls back to anthropic models when neither override nor app default is set", async () => {
    stateRef.current = {
      settings: { ...baseSettings, defaultProvider: undefined },
    }
    const user = userEvent.setup()
    render(
      <ModelOverrideFields
        value={undefined}
        providers={openaiOnly}
        onChange={jest.fn()}
        labels={labels}
      />
    )
    await user.click(screen.getByRole("combobox", { name: "Model" }))
    expect(await screen.findByRole("option", { name: "Claude X" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "GPT-4o" })).not.toBeInTheDocument()
  })

  it("propagates a model selection", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(
      <ModelOverrideFields
        value={{ providerOverride: "openai" }}
        providers={openaiOnly}
        onChange={onChange}
        labels={labels}
      />
    )
    await user.click(screen.getByRole("combobox", { name: "Model" }))
    await user.click(await screen.findByRole("option", { name: "GPT-4o mini" }))
    expect(onChange).toHaveBeenCalledWith({ model: "gpt-4o-mini" })
  })

  it("clears the model back to the provider default", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(
      <ModelOverrideFields
        value={{ providerOverride: "openai", model: "gpt-4o" }}
        providers={openaiOnly}
        onChange={onChange}
        labels={labels}
      />
    )
    await user.click(screen.getByRole("combobox", { name: "Model" }))
    await user.click(await screen.findByRole("option", { name: "Use chat default" }))
    expect(onChange).toHaveBeenCalledWith({ model: undefined })
  })

  it("keeps a stored model that isn't in the catalog selectable", async () => {
    const user = userEvent.setup()
    render(
      <ModelOverrideFields
        value={{ providerOverride: "openai", model: "legacy-model" }}
        providers={openaiOnly}
        onChange={jest.fn()}
        labels={labels}
      />
    )
    await user.click(screen.getByRole("combobox", { name: "Model" }))
    expect(await screen.findByRole("option", { name: "legacy-model" })).toBeInTheDocument()
  })
})

describe("ModelOverrideFields — state unification on provider switch", () => {
  it("drops a stale model when switching to a provider that can't serve it", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(
      <ModelOverrideFields
        value={{ providerOverride: "openai", model: "gpt-4o" }}
        providers={[
          { id: "openai", name: "openai" },
          { id: "my-local", name: "My Local" },
        ]}
        onChange={onChange}
        labels={labels}
      />
    )
    await user.click(screen.getByRole("combobox", { name: "Provider" }))
    await user.click(await screen.findByRole("option", { name: "My Local" }))
    expect(onChange).toHaveBeenCalledWith({ providerOverride: "my-local", model: undefined })
  })

  it("keeps a model the new effective provider can still serve", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(
      <ModelOverrideFields
        value={{ providerOverride: "openai", model: "gpt-4o" }}
        providers={openaiOnly}
        onChange={onChange}
        labels={labels}
      />
    )
    // Switch back to "use chat default"; the app default provider is openai, which
    // still serves gpt-4o, so the model is preserved (no model key in the patch).
    await user.click(screen.getByRole("combobox", { name: "Provider" }))
    await user.click(await screen.findByRole("option", { name: "Use chat default" }))
    expect(onChange).toHaveBeenCalledWith({ providerOverride: undefined })
  })
})

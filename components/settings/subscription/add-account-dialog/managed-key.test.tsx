/** @jest-environment jsdom */
import { selectOption } from "@/lib/testing/select-option"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { SubscriptionProviderDefinition } from "@/lib/subscription/core/provider-registry"

const definition: SubscriptionProviderDefinition = {
  id: "custom-service",
  name: "Custom Service",
  source: "custom",
  authMode: "api-key",
  baseUrl: "https://custom.example/v1",
  protocol: "openai",
  models: ["model-a"],
}
const discoverModels = jest.fn()
const getModel = jest.fn()
jest.mock("@/lib/subscription/core/model-discovery", () => ({
  discoverSubscriptionModels: (...args: unknown[]) => discoverModels(...args),
  getSubscriptionModel: (...args: unknown[]) => getModel(...args),
  SubscriptionModelDiscoveryError: class extends Error {},
}))
const persist = jest.fn()
const saveDefinition = jest.fn()
jest.mock("@/lib/subscription/core/account-lifecycle", () => ({
  persistProviderAccount: (...args: unknown[]) => persist(...args),
}))
jest.mock("@/lib/subscription/core/provider-registry", () => ({
  saveCustomSubscriptionProvider: (...args: unknown[]) => saveDefinition(...args),
}))
jest.mock("@/lib/subscription/core/transport", () => ({
  listPresets: jest.fn(async () => []),
  replaceAccountCredential: jest.fn(),
}))
import { listPresets, replaceAccountCredential } from "@/lib/subscription/core/transport"
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
import { ManagedKeyAccountDialog } from "./managed-key"

beforeEach(() => {
  jest.clearAllMocks()
  persist.mockImplementation(async (_provider, account) => account)
  saveDefinition.mockResolvedValue(definition)
})

const subscriptionDefinition: SubscriptionProviderDefinition = {
  ...definition,
  id: "plugin:subscription",
  source: "plugin",
  billingMode: "subscription",
  usage: {
    baseUrl: "https://quota.vendor.example/v2",
    request: { path: "/quota", useBaseUrlOrigin: true },
    extract: {
      kind: "window",
      windows: [{ id: "plan", labelKey: "subscription.limits.meter.plan", usedPctPath: "percent" }],
    },
  },
}

it("keeps subscription key destinations fixed and omits presets when creating an account", async () => {
  render(
    <ManagedKeyAccountDialog definition={subscriptionDefinition} open onOpenChange={jest.fn()} />
  )
  expect(screen.queryByLabelText("Base URL (optional)")).not.toBeInTheDocument()
  expect(screen.queryByText("Endpoint preset")).not.toBeInTheDocument()
  expect(listPresets).not.toHaveBeenCalled()
  expect(screen.getByText("https://custom.example/v1")).toBeInTheDocument()
  expect(screen.getByText("https://quota.vendor.example/quota")).toBeInTheDocument()
  expect(screen.getByText(/cannot determine a key’s billing type/)).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText("Subscription key"), {
    target: { value: "subscription-key" },
  })
  await userEvent.click(screen.getByRole("button", { name: "Save" }))
  expect(persist).toHaveBeenCalledWith(
    "plugin:subscription",
    expect.objectContaining({
      credential: expect.objectContaining({
        baseUrl: definition.baseUrl,
        accessToken: "subscription-key",
      }),
    })
  )
  expect(persist.mock.calls[0][1]).not.toHaveProperty("presetId")
})

it("replaces a subscription key using the declared endpoint without exposing URL overrides", async () => {
  jest
    .mocked(replaceAccountCredential)
    .mockResolvedValue({ id: "existing", provider: "plugin:subscription" } as Awaited<
      ReturnType<typeof replaceAccountCredential>
    >)
  render(
    <ManagedKeyAccountDialog
      definition={subscriptionDefinition}
      existingAccount={
        { id: "existing", provider: "plugin:subscription", label: "Work" } as NonNullable<
          Parameters<typeof ManagedKeyAccountDialog>[0]["existingAccount"]
        >
      }
      open
      onOpenChange={jest.fn()}
    />
  )
  fireEvent.change(screen.getByLabelText("Subscription key"), {
    target: { value: "replacement-key" },
  })
  await userEvent.click(screen.getByRole("button", { name: "Save" }))
  expect(replaceAccountCredential).toHaveBeenCalledWith(
    "plugin:subscription",
    "existing",
    expect.objectContaining({ baseUrl: definition.baseUrl, accessToken: "replacement-key" })
  )
  expect(screen.queryByLabelText("Base URL (optional)")).not.toBeInTheDocument()
})

it("creates custom service metadata separately from the vault secret", async () => {
  const onAdded = jest.fn()
  render(<ManagedKeyAccountDialog open onOpenChange={jest.fn()} onAdded={onAdded} />)
  fireEvent.change(screen.getByLabelText("Service name"), { target: { value: "Custom Service" } })
  fireEvent.change(screen.getByLabelText("Base URL"), {
    target: { value: "https://custom.example/v1" },
  })
  fireEvent.change(screen.getByLabelText("Model IDs (comma separated)"), {
    target: { value: "model-a, model-a, model-b" },
  })
  await selectOption(screen.getByLabelText("API protocol"), "anthropic")
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "secret-key" } })
  await userEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(onAdded).toHaveBeenCalled())
  expect(saveDefinition).toHaveBeenCalledWith({
    name: "Custom Service",
    baseUrl: "https://custom.example/v1",
    protocol: "anthropic",
    models: ["model-a", "model-b"],
  })
  expect(persist).toHaveBeenCalledWith(
    "custom-service",
    expect.objectContaining({
      credential: expect.objectContaining({
        provider: "api-key",
        providerId: "custom-service",
        accessToken: "secret-key",
      }),
    })
  )
})

it("requires enough configuration to make a custom subscription usable", async () => {
  render(<ManagedKeyAccountDialog open onOpenChange={jest.fn()} />)
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "secret-key" } })
  await userEvent.click(screen.getByRole("button", { name: "Save" }))
  expect(screen.getByRole("alert")).toHaveTextContent("at least one model ID")
  expect(saveDefinition).not.toHaveBeenCalled()
  expect(persist).not.toHaveBeenCalled()
})

it("reuses the created definition when saving the vault key is retried", async () => {
  persist.mockRejectedValueOnce(new Error("keyring locked"))
  render(<ManagedKeyAccountDialog open onOpenChange={jest.fn()} />)
  fireEvent.change(screen.getByLabelText("Service name"), { target: { value: "Custom Service" } })
  fireEvent.change(screen.getByLabelText("Base URL"), {
    target: { value: "https://custom.example/v1" },
  })
  fireEvent.change(screen.getByLabelText("Model IDs (comma separated)"), {
    target: { value: "model-a" },
  })
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "secret-key" } })
  await userEvent.click(screen.getByRole("button", { name: "Save" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("keyring locked")
  await userEvent.click(screen.getByRole("button", { name: "Save" }))
  expect(saveDefinition).toHaveBeenCalledTimes(1)
  expect(persist).toHaveBeenCalledTimes(2)
})

it("adds a plugin-defined API account without writing custom provider settings", async () => {
  render(
    <ManagedKeyAccountDialog
      definition={{ ...definition, id: "plugin:service", source: "plugin" }}
      open
      onOpenChange={jest.fn()}
    />
  )
  expect(screen.queryByLabelText("Service name")).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "plugin-key" } })
  await userEvent.click(screen.getByRole("button", { name: "Save" }))
  expect(persist).toHaveBeenCalledWith(
    "plugin:service",
    expect.objectContaining({
      credential: expect.objectContaining({ providerId: "plugin:service" }),
    })
  )
  expect(saveDefinition).not.toHaveBeenCalled()
})

const pluginDefinition: SubscriptionProviderDefinition = {
  ...definition,
  id: "plugin:models",
  source: "plugin",
  modelApi: { list: true, retrieve: true },
  modelMetadata: [{ id: "model-a", name: "Model A", contextLength: 128000, supportsVision: false }],
}

it("shows declared metadata and fetches live model lists and details with transient inputs", async () => {
  discoverModels.mockResolvedValue({
    models: [{ id: "live", name: "Live model", contextLength: 256000 }],
    freshness: "fresh",
  })
  getModel.mockResolvedValue({
    model: { id: "live", name: "Live model", supportsTools: true, maxOutputTokens: 16000 },
  })
  render(<ManagedKeyAccountDialog definition={pluginDefinition} open onOpenChange={jest.fn()} />)
  expect(screen.getByText("128,000")).toBeInTheDocument()
  expect(screen.getByText("Not supported")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Fetch models" })).toBeDisabled()
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "preview-key" } })
  fireEvent.change(screen.getByLabelText("Base URL (optional)"), {
    target: { value: "https://override.example/v1" },
  })
  await userEvent.click(screen.getByRole("button", { name: "Fetch models" }))
  expect(await screen.findByText("256,000")).toBeInTheDocument()
  expect(discoverModels).toHaveBeenCalledWith(
    expect.objectContaining({
      definition: pluginDefinition,
      preview: { apiKey: "preview-key", baseUrl: "https://override.example/v1", presetId: null },
    })
  )
  await userEvent.click(screen.getByRole("button", { name: "Fetch model information" }))
  expect(await screen.findByText("16,000")).toBeInTheDocument()
  expect(getModel).toHaveBeenCalledWith(expect.objectContaining({ model: "live" }))
  expect(persist).not.toHaveBeenCalled()
})

it("keeps manual save available after discovery fails", async () => {
  discoverModels.mockRejectedValue(new Error("API request rejected"))
  render(<ManagedKeyAccountDialog definition={pluginDefinition} open onOpenChange={jest.fn()} />)
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "preview-key" } })
  await userEvent.click(screen.getByRole("button", { name: "Fetch models" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("You can still save")
  await userEvent.click(screen.getByRole("button", { name: "Save" }))
  expect(persist).toHaveBeenCalled()
})

it("discards late model responses after key changes and closing/reopening", async () => {
  let finish!: (value: unknown) => void
  discoverModels.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const { rerender } = render(
    <ManagedKeyAccountDialog definition={pluginDefinition} open onOpenChange={jest.fn()} />
  )
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "first-key" } })
  await userEvent.click(screen.getByRole("button", { name: "Fetch models" }))
  const signal = discoverModels.mock.calls[0][0].signal
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "second-key" } })
  expect(signal.aborted).toBe(true)
  rerender(
    <ManagedKeyAccountDialog definition={pluginDefinition} open={false} onOpenChange={jest.fn()} />
  )
  rerender(<ManagedKeyAccountDialog definition={pluginDefinition} open onOpenChange={jest.fn()} />)
  await act(async () =>
    finish({ models: [{ id: "stale", name: "Stale model" }], freshness: "fresh" })
  )
  expect(screen.queryByText("Stale model")).not.toBeInTheDocument()
  expect(screen.getByLabelText("API key")).toHaveValue("")
  expect(screen.getByText("128,000")).toBeInTheDocument()
})

it("shows explicit zero prices with currency without inventing missing prices", () => {
  render(
    <ManagedKeyAccountDialog
      definition={{
        ...pluginDefinition,
        modelMetadata: [{ id: "model-a", pricing: { promptPer1M: 0, currency: "CNY" } }],
      }}
      open
      onOpenChange={jest.fn()}
    />
  )
  expect(screen.getByText("Input / 1M tokens (CNY)")).toBeInTheDocument()
  expect(screen.getByText("0")).toBeInTheDocument()
  expect(screen.queryByText("Output / 1M tokens (CNY)")).not.toBeInTheDocument()
})

it("does not label normalized unknown model capabilities as verified facts", async () => {
  discoverModels.mockResolvedValue({
    models: [
      {
        id: "unknown",
        name: "Unknown model",
        contextLength: 0,
        supportsTools: true,
        supportsVision: false,
        pricing: { promptPer1M: 0, completionPer1M: 0 },
        knownFields: ["id", "name"],
      },
    ],
    freshness: "fresh",
  })
  render(<ManagedKeyAccountDialog definition={pluginDefinition} open onOpenChange={jest.fn()} />)
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "preview-key" } })
  await userEvent.click(screen.getByRole("button", { name: "Fetch models" }))
  expect(
    await screen.findByRole("option", { hidden: true, name: "Unknown model" })
  ).toBeInTheDocument()
  expect(screen.queryByText("Tool calls")).not.toBeInTheDocument()
  expect(screen.queryByText("Vision")).not.toBeInTheDocument()
  expect(screen.queryByText("Context tokens")).not.toBeInTheDocument()
  expect(screen.queryByText("Input / 1M tokens (USD)")).not.toBeInTheDocument()
})

it("shows context, maximum input and maximum output as separate known limits", () => {
  render(
    <ManagedKeyAccountDialog
      definition={{
        ...pluginDefinition,
        modelMetadata: [
          { id: "model-a", contextLength: 200000, maxInputTokens: 128000, maxOutputTokens: 32000 },
        ],
      }}
      open
      onOpenChange={jest.fn()}
    />
  )
  expect(screen.getByText("Context tokens").nextElementSibling).toHaveTextContent("200,000")
  expect(screen.getByText("Maximum input tokens").nextElementSibling).toHaveTextContent("128,000")
  expect(screen.getByText("Maximum output tokens").nextElementSibling).toHaveTextContent("32,000")
})

it("omits unknown input and output limits from live metadata", async () => {
  discoverModels.mockResolvedValue({
    models: [
      {
        id: "unknown",
        name: "Unknown model",
        contextLength: 200000,
        maxInputTokens: 128000,
        maxOutputTokens: 32000,
        knownFields: ["id", "name", "contextLength"],
      },
    ],
    freshness: "fresh",
  })
  render(<ManagedKeyAccountDialog definition={pluginDefinition} open onOpenChange={jest.fn()} />)
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "preview-key" } })
  await userEvent.click(screen.getByRole("button", { name: "Fetch models" }))
  expect(
    await screen.findByRole("option", { hidden: true, name: "Unknown model" })
  ).toBeInTheDocument()
  expect(screen.getByText("200,000")).toBeInTheDocument()
  expect(screen.queryByText("Maximum input tokens")).not.toBeInTheDocument()
  expect(screen.queryByText("Maximum output tokens")).not.toBeInTheDocument()
})

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import { CogniaModelPicker } from "./cognia-model-picker"

const binding = { providerId: "gateway", modelId: "coder", accountId: "account-a" }
const settings = {
  providerSettings: { gateway: { enabled: true, apiKey: "fixture" } },
  customProviders: [],
}
const discoveryMock = jest.fn()
const detailMock = jest.fn()
const subscriptionMock = jest.fn()
const owner = { id: "owner-one" }
const accountLists = { enabled: false }
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (select: (s: unknown) => unknown) => select({ unlockedAccountId: owner.id }),
}))
jest.mock("@/lib/subscription/core/model-discovery", () => ({
  discoverSubscriptionModels: (...args: unknown[]) => discoveryMock(...args),
  getSubscriptionModel: (...args: unknown[]) => detailMock(...args),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (select: (s: unknown) => unknown) => select({ settings }),
}))
jest.mock("@cognia/provider-types/provider", () => ({
  getAllProviders: () => ({ gateway: { protocol: "openai" } }),
}))
jest.mock("@/lib/ai/agent/external/gateway-task", () => ({
  canUseCogniaModels: (config: { protocol: string }) => config.protocol === "pi-rpc",
}))
jest.mock("@/lib/ai/model-options", () => ({
  collectModelOptions: (configs: { gateway?: { discoveredModels?: Array<{ id: string }> } }) => [
    { providerId: "gateway", providerName: "Gateway", modelId: "coder", modelName: "Coder" },
    { providerId: "gateway", providerName: "Gateway", modelId: "no-tools", modelName: "No tools" },
    ...(configs.gateway?.discoveredModels ?? []).map((model) => ({
      providerId: "gateway",
      providerName: "Gateway",
      modelId: model.id,
      modelName: model.id,
    })),
  ],
  resolveModelMeta: (
    _provider: string,
    model: string,
    configs: { gateway?: { discoveredModels?: Array<{ id: string }> } }
  ) =>
    configs.gateway?.discoveredModels?.find((entry) => entry.id === model) ??
    (model === "coder"
      ? {
          contextLength: 200000,
          maxInputTokens: 128000,
          maxOutputTokens: 32000,
          supportsTools: true,
        }
      : { supportsTools: false }),
}))
jest.mock("@/lib/subscription/core/provider-registry", () => ({
  getSubscriptionProvider: (...args: unknown[]) => subscriptionMock(...args),
}))
jest.mock("@/lib/subscription/core/hooks", () => ({
  useSubscriptionProviders: () => [],
  useAccounts: () => {
    const React = jest.requireActual<typeof import("react")>("react")
    const [accounts] = React.useState(() =>
      accountLists.enabled ? [{ id: "account-a", label: owner.id }] : []
    )
    return { accounts, loading: false }
  },
}))
jest.mock("@/components/shared/responsive-picker", () => ({
  ResponsivePicker: ({
    trigger,
    children,
  }: {
    trigger: React.ReactNode
    children: React.ReactNode
  }) => (
    <div>
      {trigger}
      {children}
    </div>
  ),
}))
jest.mock("@/components/settings/provider/provider-model-list", () => ({
  ProviderModelList: ({
    groups,
    onSelect,
  }: {
    groups: { providerId: string; models: string[] }[]
    onSelect: (provider: string, model: string) => void
  }) => (
    <div>
      {groups.flatMap((group) =>
        group.models.map((model) => (
          <button key={model} onClick={() => onSelect(group.providerId, model)}>
            {model}
          </button>
        ))
      )}
    </div>
  ),
}))

function mount(value: typeof binding | null, onChange = jest.fn(), protocol = "pi-rpc") {
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <CogniaModelPicker
        config={{ protocol, transport: "stdio", process: { command: "pi", args: [] } }}
        value={value}
        onChange={onChange}
      />
    </NextIntlClientProvider>
  )
  return onChange
}

beforeEach(() => {
  jest.clearAllMocks()
  subscriptionMock.mockReturnValue(undefined)
  owner.id = "owner-one"
  accountLists.enabled = false
})

it("reloads the account list when the active Cognia owner changes", () => {
  subscriptionMock.mockReturnValue({ id: "gateway", authMode: "api-key", protocol: "openai" })
  accountLists.enabled = true
  const view = () => (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <CogniaModelPicker
        config={{ protocol: "pi-rpc", transport: "stdio" }}
        value={binding}
        onChange={jest.fn()}
      />
    </NextIntlClientProvider>
  )
  const rendered = render(view())
  expect(screen.getByRole("combobox", { name: "Subscription account" })).toHaveTextContent(
    "owner-one"
  )
  owner.id = "owner-two"
  rendered.rerender(view())
  expect(screen.getByRole("combobox", { name: "Subscription account" })).toHaveTextContent(
    "owner-two"
  )
  expect(screen.queryByText("owner-one")).not.toBeInTheDocument()
})

it("shows distinct context/input/output limits and filters known incompatible models", () => {
  mount(binding)
  expect(screen.getByText("Context: 200,000")).toBeInTheDocument()
  expect(screen.getByText("Maximum input: 128,000")).toBeInTheDocument()
  expect(screen.getByText("Maximum output: 32,000")).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "no-tools" })).not.toBeInTheDocument()
})

it("preserves the subscription account when selecting a model from that provider", () => {
  const change = mount(binding)
  fireEvent.click(screen.getByRole("button", { name: "coder", exact: true }))
  expect(change).toHaveBeenCalledWith(binding)
})

it("can clear an existing binding when the runtime becomes unsupported", () => {
  const change = mount(binding, jest.fn(), "a2a")
  fireEvent.click(screen.getByRole("switch", { name: "Use Cognia models" }))
  expect(change).toHaveBeenCalledWith(null)
})

it("does not offer gateway mode for an unsupported runtime", () => {
  mount(null, jest.fn(), "a2a")
  expect(screen.getByRole("switch", { name: "Use Cognia models" })).toBeDisabled()
})

it("discovers account-specific models transiently and exposes their capabilities", async () => {
  const definition = { id: "gateway", authMode: "api-key", modelApi: { list: true } }
  subscriptionMock.mockReturnValue(definition)
  discoveryMock.mockResolvedValue({
    models: [
      { id: "live-model", contextLength: 256000, maxOutputTokens: 8000, supportsTools: true },
    ],
  })
  const change = mount(binding)
  fireEvent.click(screen.getByRole("button", { name: "Refresh account models" }))
  await screen.findByText("Account model information updated.")
  expect(discoveryMock).toHaveBeenCalledWith({
    definition,
    accountId: "account-a",
    signal: expect.any(AbortSignal),
  })
  fireEvent.click(screen.getByRole("button", { name: "live-model" }))
  expect(change).toHaveBeenCalledWith({ ...binding, modelId: "live-model" })
  expect(settings.providerSettings.gateway).toEqual({ enabled: true, apiKey: "fixture" })
})

it("refreshes current model limits and represents explicit unsupported capabilities", async () => {
  subscriptionMock.mockReturnValue({
    id: "gateway",
    authMode: "api-key",
    modelApi: { list: true, retrieve: true },
  })
  detailMock.mockResolvedValue({
    model: {
      id: "coder",
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true,
      maxOutputTokens: 4096,
    },
  })
  mount(binding)
  fireEvent.click(screen.getByRole("button", { name: "Refresh model details" }))
  expect(await screen.findByText("Maximum output: 4,096")).toBeInTheDocument()
  expect(screen.getByText("Images: not supported")).toBeInTheDocument()
  expect(screen.getByText("Structured output: supported")).toBeInTheDocument()
})

it("aborts pending discovery on unmount and retains models after failure", async () => {
  subscriptionMock.mockReturnValue({ id: "gateway", authMode: "api-key", modelApi: { list: true } })
  discoveryMock.mockRejectedValueOnce(new Error("unavailable"))
  const { unmount } = render(
    <NextIntlClientProvider locale="en" messages={en}>
      <CogniaModelPicker
        config={{ protocol: "pi-rpc", transport: "stdio", process: { command: "pi" } }}
        value={binding}
        onChange={jest.fn()}
      />
    </NextIntlClientProvider>
  )
  fireEvent.click(screen.getByRole("button", { name: "Refresh account models" }))
  await screen.findByText(/Could not load model information/)
  expect(screen.getByRole("button", { name: "coder", exact: true })).toBeInTheDocument()
  discoveryMock.mockImplementationOnce(() => new Promise(() => {}))
  fireEvent.click(screen.getByRole("button", { name: "Refresh account models" }))
  const signal = discoveryMock.mock.calls.at(-1)[0].signal as AbortSignal
  unmount()
  expect(signal.aborted).toBe(true)
})

it("does not show a late response from a different account", async () => {
  const definition = { id: "gateway", authMode: "api-key", modelApi: { list: true } }
  subscriptionMock.mockReturnValue(definition)
  let complete!: (value: unknown) => void
  discoveryMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const view = (accountId: string) => (
    <NextIntlClientProvider locale="en" messages={en}>
      <CogniaModelPicker
        config={{ protocol: "pi-rpc", transport: "stdio", process: { command: "pi" } }}
        value={{ ...binding, accountId }}
        onChange={jest.fn()}
      />
    </NextIntlClientProvider>
  )
  const { rerender } = render(view("account-a"))
  fireEvent.click(screen.getByRole("button", { name: "Refresh account models" }))
  rerender(view("account-b"))
  await act(async () => {
    complete({ models: [{ id: "account-a-private", supportsTools: true }] })
  })
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "account-a-private" })).not.toBeInTheDocument()
  )
})

it("allows refreshing again after a pending request is aborted by switching away and back", () => {
  subscriptionMock.mockReturnValue({ id: "gateway", authMode: "api-key", modelApi: { list: true } })
  discoveryMock.mockImplementation(() => new Promise(() => {}))
  const view = (accountId: string) => (
    <NextIntlClientProvider locale="en" messages={en}>
      <CogniaModelPicker
        config={{ protocol: "pi-rpc", transport: "stdio", process: { command: "pi" } }}
        value={{ ...binding, accountId }}
        onChange={jest.fn()}
      />
    </NextIntlClientProvider>
  )
  const { rerender } = render(view("account-a"))
  fireEvent.click(screen.getByRole("button", { name: "Refresh account models" }))
  expect(screen.getByRole("button", { name: "Refresh account models" })).toBeDisabled()
  const signal = discoveryMock.mock.calls[0][0].signal as AbortSignal
  rerender(view("account-b"))
  rerender(view("account-a"))
  expect(signal.aborted).toBe(true)
  expect(screen.getByRole("button", { name: "Refresh account models" })).toBeEnabled()
  expect(screen.getByRole("button", { name: "Refresh model details" })).toBeEnabled()
  fireEvent.click(screen.getByRole("button", { name: "Refresh account models" }))
  expect(discoveryMock).toHaveBeenCalledTimes(2)
})

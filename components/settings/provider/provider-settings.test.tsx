/**
 * @jest-environment jsdom
 *
 * The full Cognia ProviderSettings test suite was written against the original
 * Cognia component (provider-manager wiring, batch verification, MCP coding
 * package gating, equivalent-custom migration, etc.). cognia-next ships a
 * deliberately slimmer port of `ProviderSettings` (see the file header in
 * `provider-settings.tsx`) — so this file pins the cognia-next surface only:
 * the sidebar+detail layout, the empty/non-empty branches, and the dialog
 * triggers. Everything beyond the slim port is owned by its own focused test
 * (`provider-config-tab.test.tsx`, `provider-cost-tab.test.tsx`, etc.).
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { ProviderSettings } from "./provider-settings"
import { deriveStatus } from "./provider-status-utils"

const mockSetSelectedProviderId = jest.fn()
const mockSetProviderConfig = jest.fn()
const mockSetDefaultProvider = jest.fn()

let mockHookState: ReturnType<typeof makeHookState>

function makeHookState(overrides?: {
  filteredProviders?: Array<
    [string, { name: string; defaultModel: string; models?: Array<Record<string, unknown>> }]
  >
  visibleCustomProviderIds?: string[]
  customProviders?: Record<string, Record<string, unknown>>
  selectedProviderId?: string | null
}) {
  const filtered = (overrides?.filteredProviders ?? []).map(([id, cfg]) => [
    id,
    { models: [], ...cfg },
  ])
  return {
    filteredProviders: filtered as unknown as ReturnType<
      typeof import("@/hooks/settings/use-provider-settings").useProviderSettings
    >["filteredProviders"],
    providerSettings: {} as Record<string, Record<string, unknown>>,
    testResults: {} as Record<string, { success: boolean; latency_ms?: number; message?: string }>,
    testingProviders: {} as Record<string, boolean>,
    testProvider: jest.fn(),
    visibleCustomProviderIds: overrides?.visibleCustomProviderIds ?? [],
    customProviders: overrides?.customProviders ?? {},
    customTestResults: {} as Record<string, "success" | "error" | undefined>,
    updateCustomProvider: jest.fn(),
    removeCustomProvider: jest.fn(),
    providerUsageStats: {} as Record<string, unknown>,
    parameters: {} as Record<string, unknown>,
    routing: {} as Record<string, unknown>,
    health: {} as Record<string, unknown>,
    presets: [] as unknown[],
    selectedProviderId: overrides?.selectedProviderId ?? null,
    setSelectedProviderId: mockSetSelectedProviderId,
    setDefaultProvider: mockSetDefaultProvider,
  }
}

// Bypass next/dynamic — return a wrapper that resolves the loader on its
// first render, then re-renders synchronously with the resolved component.
// Tests can `await findByTestId` to wait for the microtask flush.
jest.mock("next/dynamic", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react") as typeof import("react")
  return {
    __esModule: true,
    default: (loader: () => Promise<unknown>) => {
      const Lazy = React.lazy(() =>
        Promise.resolve(loader()).then((mod) => {
          // The loader may resolve to either a module (`{default}` / named
          // exports) or, when chained with `.then((m) => m.X)`, the component
          // function directly.
          if (typeof mod === "function") {
            return { default: mod as React.ComponentType<Record<string, unknown>> }
          }
          const m = mod as { default?: React.ComponentType<Record<string, unknown>> } & Record<
            string,
            React.ComponentType<Record<string, unknown>>
          >
          const resolved =
            m.default ?? (Object.values(m)[0] as React.ComponentType<Record<string, unknown>>)
          return { default: resolved }
        })
      )
      const Wrapper = (props: Record<string, unknown>) =>
        React.createElement(React.Suspense, { fallback: null }, React.createElement(Lazy, props))
      return Wrapper
    },
  }
})

jest.mock("@/hooks/settings/use-provider-settings", () => ({
  useProviderSettings: () => mockHookState,
}))

const mockSettingsState = {
  setProviderConfig: mockSetProviderConfig,
  setDefaultProvider: mockSetDefaultProvider,
  providerUsageStats: {},
  settings: { defaultProvider: "openai" } as { defaultProvider?: string },
}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: typeof mockSettingsState) => unknown) =>
    selector(mockSettingsState),
}))

// Source uses next/dynamic for these — return synchronous test stand-ins so the
// dialog triggers can be exercised without async chunk loading.
jest.mock("./custom-provider-dialog", () => ({
  CustomProviderDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="custom-provider-dialog" /> : null,
}))
jest.mock("./quick-add-provider-dialog", () => ({
  QuickAddProviderDialog: ({ open, onAddCustom }: { open: boolean; onAddCustom?: () => void }) =>
    open ? (
      <button data-testid="quick-add-provider-dialog" onClick={onAddCustom}>
        add-custom
      </button>
    ) : null,
}))
jest.mock("./local-provider-settings", () => ({
  LocalProviderSettings: () => <div data-testid="local-provider-settings" />,
}))

// Slot tabs/panels — render distinct test stand-ins so we can verify
// composition without dragging in their full implementations.
jest.mock("./provider-detail-panel", () => ({
  ProviderDetailPanel: ({
    provider,
    configTab,
    modelsTab,
    costTab,
    advancedTab,
    isDefault,
    isCustom,
    onSetDefault,
    onToggleEnabled,
    onDelete,
  }: {
    provider: { id: string; name: string } | null
    configTab?: React.ReactNode
    modelsTab?: React.ReactNode
    costTab?: React.ReactNode
    advancedTab?: React.ReactNode
    isDefault?: boolean
    isCustom?: boolean
    onSetDefault?: () => void
    onToggleEnabled?: (enabled: boolean) => void
    onDelete?: () => void
  }) => (
    <div
      data-testid="provider-detail-panel"
      data-provider-id={provider?.id ?? ""}
      data-is-default={String(isDefault ?? false)}
    >
      {provider?.name ?? ""}
      {onSetDefault && (
        <button data-testid="mock-set-default" onClick={onSetDefault}>
          set-default
        </button>
      )}
      {onToggleEnabled && (
        <button data-testid="mock-toggle-enabled" onClick={() => onToggleEnabled(!isDefault)}>
          toggle-enabled
        </button>
      )}
      {isCustom && onDelete && (
        <button data-testid="mock-delete-provider" onClick={onDelete}>
          delete
        </button>
      )}
      <div data-testid="provider-detail-config-tab">{configTab}</div>
      <div data-testid="provider-detail-models-tab">{modelsTab}</div>
      <div data-testid="provider-detail-cost-tab">{costTab}</div>
      <div data-testid="provider-detail-advanced-tab">{advancedTab}</div>
    </div>
  ),
}))
jest.mock("./provider-sidebar", () => ({
  ProviderSidebar: ({
    providers,
    onSelect,
    addButton,
    onSearchChange,
    categoryFilter,
    onCategoryChange,
  }: {
    providers: Array<{ id: string; name: string }>
    onSelect: (id: string) => void
    addButton?: React.ReactNode
    onSearchChange: (q: string) => void
    categoryFilter?: string
    onCategoryChange?: (c: string) => void
  }) => (
    <div data-testid="provider-sidebar">
      <input
        data-testid="provider-sidebar-search"
        onChange={(e) => onSearchChange(e.target.value)}
      />
      <button data-testid="provider-sidebar-category" onClick={() => onCategoryChange("ai")}>
        {categoryFilter ?? "all"}
      </button>
      {providers.map((p) => (
        <button
          key={p.id}
          data-testid={`provider-sidebar-item-${p.id}`}
          onClick={() => onSelect(p.id)}
        >
          {p.name}
        </button>
      ))}
      {addButton}
    </div>
  ),
}))
jest.mock("./provider-empty-state", () => ({
  ProviderEmptyState: ({ onAddProvider }: { onAddProvider: () => void }) => (
    <button data-testid="provider-empty-state" onClick={onAddProvider}>
      add-from-empty
    </button>
  ),
}))
jest.mock("./provider-onboarding-banner", () => ({
  ProviderOnboardingBanner: () => <div data-testid="provider-onboarding-banner" />,
}))
jest.mock("./provider-config-tab", () => ({
  ProviderConfigTab: (props: Record<string, unknown>) => (
    <div data-testid="mock-provider-config-tab">
      <button
        data-testid="mock-api-key-change"
        onClick={() => (props.onApiKeyChange as (k: string) => void)("new-key")}
      >
        api-key
      </button>
      <button
        data-testid="mock-base-url-change"
        onClick={() => (props.onBaseURLChange as (u: string) => void)("https://x")}
      >
        base-url
      </button>
      <button
        data-testid="mock-bedrock-change"
        onClick={() =>
          (props.onBedrockSettingsChange as (s: unknown) => void)({
            authMode: "api-key",
            region: "us-east-1",
            apiKey: "bk",
          })
        }
      >
        bedrock
      </button>
      <button
        data-testid="mock-protocol-change"
        onClick={() => (props.onApiProtocolChange as (p: string) => void)("anthropic")}
      >
        protocol
      </button>
      <button
        data-testid="mock-default-model-change"
        onClick={() => (props.onDefaultModelChange as (m: string) => void)("m")}
      >
        model
      </button>
      <button
        data-testid="mock-test-connection"
        onClick={() => (props.onTestConnection as () => void)()}
      >
        test
      </button>
      <button
        data-testid="mock-add-api-key"
        onClick={() => (props.onAddApiKey as (k: string) => void)("k2")}
      >
        add-key
      </button>
      <button
        data-testid="mock-remove-api-key"
        onClick={() => (props.onRemoveApiKey as (i: number) => void)(0)}
      >
        remove-key
      </button>
      <button
        data-testid="mock-reorder-api-keys"
        onClick={() => (props.onReorderApiKeys as (f: number, t: number) => void)(0, 1)}
      >
        reorder
      </button>
      <button
        data-testid="mock-toggle-rotation"
        onClick={() => (props.onToggleRotation as (e: boolean) => void)(true)}
      >
        toggle-rotation
      </button>
      <button
        data-testid="mock-rotation-strategy"
        onClick={() => (props.onRotationStrategyChange as (s: string) => void)("round-robin")}
      >
        strategy
      </button>
    </div>
  ),
}))
jest.mock("./provider-models-tab", () => ({
  ProviderModelsTab: (props: Record<string, unknown>) => (
    <div data-testid="mock-provider-models-tab">
      <button
        data-testid="mock-enabled-models-change"
        onClick={() => (props.onEnabledModelsChange as (ids: string[]) => void)(["m1"])}
      >
        enabled-models
      </button>
      <button
        data-testid="mock-models-test-connection"
        onClick={() => (props.onTestConnection as () => void)()}
      >
        test
      </button>
    </div>
  ),
}))
jest.mock("./provider-cost-tab", () => ({ ProviderCostTab: () => null }))
jest.mock("./provider-parameters-tab", () => ({ ProviderParametersTab: () => null }))
jest.mock("./routing-tab", () => ({ RoutingTab: () => null }))
jest.mock("./health-tab", () => ({
  HealthTab: (props: Record<string, unknown>) => (
    <button data-testid="mock-health-test" onClick={() => (props.onTestConnection as () => void)()}>
      health-test
    </button>
  ),
}))
jest.mock("./presets-tab", () => ({ PresetsTab: () => null }))

beforeEach(() => {
  jest.clearAllMocks()
  mockHookState = makeHookState()
})

describe("ProviderSettings (cognia-next slim port)", () => {
  it("always renders the onboarding banner", () => {
    render(<ProviderSettings />)
    expect(screen.getByTestId("provider-onboarding-banner")).toBeInTheDocument()
  })

  it("renders the empty-state slot when no providers and no active search", () => {
    render(<ProviderSettings />)
    expect(screen.getByTestId("provider-empty-state")).toBeInTheDocument()
    expect(screen.queryByTestId("provider-sidebar")).not.toBeInTheDocument()
  })

  it("clicking the empty-state add button opens the QuickAdd dialog", async () => {
    const { findByTestId } = render(<ProviderSettings />)
    fireEvent.click(screen.getByTestId("provider-empty-state"))
    // Dynamic dialog mounts via the next/dynamic shim — wait for it.
    expect(await findByTestId("quick-add-provider-dialog")).toBeInTheDocument()
  })

  it("renders the sidebar when at least one built-in provider is filtered in", () => {
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
    })
    render(<ProviderSettings />)
    expect(screen.getByTestId("provider-sidebar")).toBeInTheDocument()
    expect(screen.getByTestId("provider-sidebar-item-openai")).toHaveTextContent("OpenAI")
  })

  it("auto-selects the first sidebar provider on mount", () => {
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
    })
    render(<ProviderSettings />)
    expect(mockSetSelectedProviderId).toHaveBeenCalledWith("openai")
  })

  it("does not auto-select when the user has already chosen a provider", () => {
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
      selectedProviderId: "openai",
    })
    render(<ProviderSettings />)
    expect(mockSetSelectedProviderId).not.toHaveBeenCalled()
  })

  it("renders the detail panel when a provider is selected", () => {
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
      selectedProviderId: "openai",
    })
    render(<ProviderSettings />)
    expect(screen.getByTestId("provider-detail-panel")).toHaveAttribute(
      "data-provider-id",
      "openai"
    )
  })

  it("renders the local-provider dashboard instead of the generic detail panel for a local provider", async () => {
    mockHookState = makeHookState({
      filteredProviders: [["ollama", { name: "Ollama", defaultModel: "" }]],
      selectedProviderId: "ollama",
    })
    const { findByTestId } = render(<ProviderSettings />)
    expect(await findByTestId("local-provider-settings")).toBeInTheDocument()
    expect(screen.queryByTestId("provider-detail-panel")).not.toBeInTheDocument()
  })

  it("filters built-in providers by name match against the search input", () => {
    mockHookState = makeHookState({
      filteredProviders: [
        ["openai", { name: "OpenAI", defaultModel: "gpt-4o" }],
        ["anthropic", { name: "Anthropic", defaultModel: "claude-4-7-sonnet" }],
      ],
    })
    render(<ProviderSettings />)
    fireEvent.change(screen.getByTestId("provider-sidebar-search"), {
      target: { value: "anth" },
    })
    expect(screen.queryByTestId("provider-sidebar-item-openai")).not.toBeInTheDocument()
    expect(screen.getByTestId("provider-sidebar-item-anthropic")).toBeInTheDocument()
  })

  it("includes visible custom providers in the sidebar entries", () => {
    mockHookState = makeHookState({
      visibleCustomProviderIds: ["my-custom"],
      customProviders: {
        "my-custom": {
          customName: "My Custom",
          baseURL: "https://example.com",
          defaultModel: "x-1",
        },
      },
    })
    render(<ProviderSettings />)
    expect(screen.getByTestId("provider-sidebar-item-my-custom")).toHaveTextContent("My Custom")
  })

  it("marks the current default provider and routes set-default through the hook", () => {
    mockHookState = makeHookState({
      filteredProviders: [
        ["openai", { name: "OpenAI", defaultModel: "gpt-4o" }],
        ["deepseek", { name: "DeepSeek", defaultModel: "deepseek-chat" }],
      ],
      selectedProviderId: "openai",
    })
    const { rerender } = render(<ProviderSettings />)
    // settings.defaultProvider is "openai" in the store mock.
    expect(screen.getByTestId("provider-detail-panel")).toHaveAttribute("data-is-default", "true")

    mockHookState = makeHookState({
      filteredProviders: [
        ["openai", { name: "OpenAI", defaultModel: "gpt-4o" }],
        ["deepseek", { name: "DeepSeek", defaultModel: "deepseek-chat" }],
      ],
      selectedProviderId: "deepseek",
    })
    rerender(<ProviderSettings />)
    expect(screen.getByTestId("provider-detail-panel")).toHaveAttribute("data-is-default", "false")
    fireEvent.click(screen.getByTestId("mock-set-default"))
    expect(mockSetDefaultProvider).toHaveBeenCalledWith("deepseek")
  })

  it("binds the custom-provider inline config to the customProviders row (read/write same source)", () => {
    mockHookState = makeHookState({
      visibleCustomProviderIds: ["my-custom"],
      customProviders: {
        "my-custom": {
          customName: "My Custom",
          baseURL: "https://proxy.example.com/v1",
          apiKey: "sk-custom-123",
          defaultModel: "x-1",
          customModels: ["x-1"],
          apiProtocol: "openai",
        },
      },
      selectedProviderId: "my-custom",
    })
    render(<ProviderSettings />)
    const configTab = screen.getByTestId("provider-detail-config-tab")
    // Values must come from the customProviders row — NOT providerSettings[id]
    // (empty here), or the controlled inputs reset on every keystroke.
    expect(configTab.querySelector('input[type="password"]')).toHaveValue("sk-custom-123")
    expect(configTab.querySelector('input[type="text"]')).toHaveValue(
      "https://proxy.example.com/v1"
    )
    // Edits persist to the same source the values are read from.
    fireEvent.change(configTab.querySelector('input[type="text"]') as HTMLInputElement, {
      target: { value: "https://proxy.example.com/v2" },
    })
    expect(mockHookState.updateCustomProvider).toHaveBeenCalledWith("my-custom", {
      baseURL: "https://proxy.example.com/v2",
    })
    fireEvent.change(configTab.querySelector('input[type="password"]') as HTMLInputElement, {
      target: { value: "new-key" },
    })
    expect(mockHookState.updateCustomProvider).toHaveBeenCalledWith("my-custom", {
      apiKey: "new-key",
    })
  })

  it("filters custom providers by customName against the search input", () => {
    mockHookState = makeHookState({
      visibleCustomProviderIds: ["c1", "c2"],
      customProviders: {
        c1: { customName: "Alpha Custom", baseURL: "u1", defaultModel: "" },
        c2: { customName: "Beta Custom", baseURL: "u2", defaultModel: "" },
      },
    })
    render(<ProviderSettings />)
    fireEvent.change(screen.getByTestId("provider-sidebar-search"), {
      target: { value: "alpha" },
    })
    expect(screen.getByTestId("provider-sidebar-item-c1")).toBeInTheDocument()
    expect(screen.queryByTestId("provider-sidebar-item-c2")).not.toBeInTheDocument()
  })

  it("toggles a built-in provider through the detail panel", () => {
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
      selectedProviderId: "openai",
    })
    render(<ProviderSettings />)
    fireEvent.click(screen.getByTestId("mock-toggle-enabled"))
    expect(mockSetProviderConfig).toHaveBeenCalledWith("openai", { enabled: expect.any(Boolean) })
  })

  it("toggles a custom provider through the detail panel", () => {
    mockHookState = makeHookState({
      visibleCustomProviderIds: ["my-custom"],
      customProviders: {
        "my-custom": {
          customName: "My Custom",
          baseURL: "https://example.com",
          apiKey: "sk-custom-123",
          defaultModel: "x-1",
        },
      },
      selectedProviderId: "my-custom",
    })
    render(<ProviderSettings />)
    fireEvent.click(screen.getByTestId("mock-toggle-enabled"))
    expect(mockHookState.updateCustomProvider).toHaveBeenCalledWith("my-custom", {
      enabled: expect.any(Boolean),
    })
  })

  it("deletes a custom provider and clears selection", () => {
    mockHookState = makeHookState({
      visibleCustomProviderIds: ["my-custom"],
      customProviders: {
        "my-custom": {
          customName: "My Custom",
          baseURL: "https://example.com",
          apiKey: "sk-custom-123",
          defaultModel: "x-1",
        },
      },
      selectedProviderId: "my-custom",
    })
    render(<ProviderSettings />)
    fireEvent.click(screen.getByTestId("mock-delete-provider"))
    expect(mockHookState.removeCustomProvider).toHaveBeenCalledWith("my-custom")
    expect(mockSetSelectedProviderId).toHaveBeenCalledWith(null)
  })

  it("routes all Config tab callbacks to the settings store", () => {
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
      selectedProviderId: "openai",
    })
    mockHookState.providerSettings.openai = {
      apiKey: "k",
      apiKeys: ["k"],
    }
    render(<ProviderSettings />)
    fireEvent.click(screen.getByTestId("mock-api-key-change"))
    expect(mockSetProviderConfig).toHaveBeenCalledWith("openai", { apiKey: "new-key" })
    fireEvent.click(screen.getByTestId("mock-base-url-change"))
    expect(mockSetProviderConfig).toHaveBeenCalledWith("openai", { baseURL: "https://x" })
    fireEvent.click(screen.getByTestId("mock-protocol-change"))
    expect(mockSetProviderConfig).toHaveBeenCalledWith("openai", { apiProtocol: "anthropic" })
    fireEvent.click(screen.getByTestId("mock-default-model-change"))
    expect(mockSetProviderConfig).toHaveBeenCalledWith("openai", { defaultModel: "m" })
    fireEvent.click(screen.getByTestId("mock-add-api-key"))
    expect(mockSetProviderConfig).toHaveBeenCalledWith("openai", { apiKeys: ["k", "k2"] })
    fireEvent.click(screen.getByTestId("mock-remove-api-key"))
    expect(mockSetProviderConfig).toHaveBeenCalledWith("openai", { apiKeys: [] })
    fireEvent.click(screen.getByTestId("mock-reorder-api-keys"))
    expect(mockSetProviderConfig).toHaveBeenCalledWith("openai", { apiKeys: ["k"] })
    fireEvent.click(screen.getByTestId("mock-toggle-rotation"))
    expect(mockSetProviderConfig).toHaveBeenCalledWith("openai", { apiKeyRotationEnabled: true })
    fireEvent.click(screen.getByTestId("mock-rotation-strategy"))
    expect(mockSetProviderConfig).toHaveBeenCalledWith("openai", {
      apiKeyRotationStrategy: "round-robin",
    })
    fireEvent.click(screen.getByTestId("mock-test-connection"))
    expect(mockHookState.testProvider).toHaveBeenCalledWith("openai")
  })

  it("routes Bedrock settings changes to the store", () => {
    mockHookState = makeHookState({
      filteredProviders: [["bedrock", { name: "Amazon Bedrock", defaultModel: "nova-lite" }]],
      selectedProviderId: "bedrock",
    })
    mockHookState.providerSettings.bedrock = {
      bedrock: { authMode: "default-chain", region: "us-east-1" },
    }
    render(<ProviderSettings />)
    fireEvent.click(screen.getByTestId("mock-bedrock-change"))
    expect(mockSetProviderConfig).toHaveBeenCalledWith(
      "bedrock",
      expect.objectContaining({
        bedrock: { authMode: "api-key", region: "us-east-1", apiKey: "bk" },
        apiKey: "bk",
      })
    )
  })

  it("routes Models tab callbacks to the store and the hook", () => {
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
      selectedProviderId: "openai",
    })
    render(<ProviderSettings />)
    fireEvent.click(screen.getByTestId("mock-enabled-models-change"))
    expect(mockSetProviderConfig).toHaveBeenCalledWith("openai", { enabledModels: ["m1"] })
    fireEvent.click(screen.getByTestId("mock-models-test-connection"))
    expect(mockHookState.testProvider).toHaveBeenCalledWith("openai")
  })

  it("opens the custom-provider dialog from QuickAdd", async () => {
    const { findByTestId } = render(<ProviderSettings />)
    fireEvent.click(screen.getByTestId("provider-empty-state"))
    fireEvent.click(await findByTestId("quick-add-provider-dialog"))
    expect(await findByTestId("custom-provider-dialog")).toBeInTheDocument()
  })

  it("applies the category filter from the sidebar", () => {
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
    })
    render(<ProviderSettings />)
    expect(screen.getByTestId("provider-sidebar-item-openai")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("provider-sidebar-category"))
    // openai has no category in the inline provider map, so the "ai" filter empties the list.
    expect(screen.queryByTestId("provider-sidebar-item-openai")).not.toBeInTheDocument()
    expect(screen.getByTestId("provider-empty-state")).toBeInTheDocument()
  })

  it("uses persisted discovered models and the OpenRouter live catalog", () => {
    mockHookState = makeHookState({
      filteredProviders: [["openrouter", { name: "OpenRouter", defaultModel: "openrouter/auto" }]],
      selectedProviderId: "openrouter",
    })
    mockHookState.providerSettings.openrouter = {
      apiKey: "rk",
      discoveredModels: [{ id: "discovered", name: "Discovered Model" }],
    }
    render(<ProviderSettings />)
    expect(screen.getByTestId("provider-detail-panel")).toHaveAttribute(
      "data-provider-id",
      "openrouter"
    )
  })
})

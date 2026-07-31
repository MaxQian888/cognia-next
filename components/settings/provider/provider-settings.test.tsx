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
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { ProviderSettings } from "./provider-settings"

const mockSyncModelsDev = jest.fn(async () => {})
const mockSyncOpenRouter = jest.fn(async (_apiKey?: string) => {})
const mockDiscoverySnapshot = jest.fn((..._args: unknown[]) => ({
  models: [] as Array<Record<string, unknown>>,
}))
let mockOpenRouterRow: { models: Array<{ id: string; name: string }> } | undefined = {
  models: [{ id: "or-1", name: "OR Model" }],
}
jest.mock("@cognia/provider-core/providers/model-discovery", () => ({
  buildBuiltInProviderModelDiscoverySnapshot: (...args: unknown[]) =>
    mockDiscoverySnapshot(...args),
}))

const mockSetSelectedProviderId = jest.fn()
const mockSetProviderConfig = jest.fn()
const mockSetDefaultProvider = jest.fn()
const mockSetProviderUIPreferences = jest.fn()

let mockHookState: ReturnType<typeof makeHookState>

function makeHookState(overrides?: {
  filteredProviders?: Array<
    [string, { name: string; defaultModel: string; models?: Array<Record<string, unknown>> }]
  >
  visibleCustomProviderIds?: string[]
  customProviders?: Record<string, Record<string, unknown>>
  customTestResults?: Record<string, "success" | "error" | "limited" | undefined>
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
    customTestResults: (overrides?.customTestResults ?? {}) as Record<
      string,
      "success" | "error" | "limited" | undefined
    >,
    testingCustomProviders: {} as Record<string, boolean>,
    testCustomProvider: jest.fn(),
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
    uiPreferences: {},
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

jest.mock("@/hooks/ai/use-provider-manager", () => ({
  useProviderManager: () => ({ providers: {}, isLoading: false, refresh: jest.fn() }),
}))

jest.mock("@/hooks/settings/use-models-dev-catalog", () => ({
  useModelsDevCatalog: () => ({
    sync: mockSyncModelsDev,
    row: {
      providers: {
        openai: {
          models: [
            {
              id: "dev-1",
              name: "Dev Model",
              maxOutputTokens: 100,
              supportsAudio: true,
              supportsVideo: true,
              supportsImageGeneration: true,
              supportsEmbedding: true,
              supportsStructuredOutput: true,
              supportsAttachment: true,
              supportsInterleaved: true,
              variants: ["a"],
              modes: ["b"],
              openWeights: true,
              family: "f",
              releaseDate: "2024",
              adapter: "ad",
              status: "active",
              knowledge: "2024",
              lastUpdated: "2024",
            },
          ],
        },
      },
    },
  }),
}))

jest.mock("@/hooks/settings/use-openrouter-catalog", () => ({
  useOpenRouterCatalog: () => ({
    sync: mockSyncOpenRouter,
    row: mockOpenRouterRow,
  }),
}))

// Exercise the defensive fallback branches (`t("key") || "Fallback"`) that
// exist for runtime safety but are otherwise dead code when i18n keys are
// present.
jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = () => ""
    ;(t as unknown as { rich: typeof t }).rich = t
    ;(t as unknown as { markup: typeof t }).markup = t
    ;(t as unknown as { has: () => boolean }).has = () => false
    ;(t as unknown as { raw: () => unknown }).raw = () => ""
    return t
  },
  useLocale: () => "en",
  useMessages: () => ({}),
  useNow: () => new Date(),
  useTimeZone: () => "UTC",
  useFormatter: () => ({
    dateTime: (d: Date | number) => new Date(d).toISOString(),
    number: (n: number) => String(n),
    relativeTime: (d: Date | number) => new Date(d).toISOString(),
    list: (items: Iterable<string>) => Array.from(items).join(", "),
  }),
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
  getTranslations: async () => () => "",
}))

// The real shadcn Tabs hide inactive content; use a tiny controlled mock so
// advanced-tab callbacks (parameters / routing / health / presets) stay
// reachable in tests.
jest.mock("@/components/ui/tabs", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react") as typeof import("react")
  const TabsContext = React.createContext<{
    value?: string
    onValueChange?: (v: string) => void
  }>({})
  return {
    Tabs: ({
      children,
      value,
      defaultValue,
      onValueChange,
    }: {
      children: React.ReactNode
      value?: string
      defaultValue?: string
      onValueChange?: (v: string) => void
    }) => {
      const [v, setV] = React.useState(value ?? defaultValue)
      React.useEffect(() => {
        if (value !== undefined) setV(value)
      }, [value])
      const handle = (val: string) => {
        setV(val)
        onValueChange?.(val)
      }
      return React.createElement(
        TabsContext.Provider,
        { value: { value: v, onValueChange: handle } },
        children
      )
    },
    TabsList: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
    TabsTrigger: ({ children, value }: { children: React.ReactNode; value: string }) => {
      const ctx = React.useContext(TabsContext)
      return React.createElement(
        "button",
        { "data-value": value, onClick: () => ctx.onValueChange?.(value) },
        children
      )
    },
    TabsContent: ({ children, value }: { children: React.ReactNode; value: string }) => {
      const ctx = React.useContext(TabsContext)
      if (ctx.value !== value) return null
      return React.createElement("div", { "data-tab": value }, children)
    },
  }
})

const mockSettingsState = {
  loaded: true,
  setProviderConfig: mockSetProviderConfig,
  setDefaultProvider: mockSetDefaultProvider,
  setProviderUIPreferences: mockSetProviderUIPreferences,
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
// Newly-mounted provider-specific panels. Each shipped fully built with a
// catalog entry and settings schema but had no mount point until now, so these
// stand-ins exist purely to prove they are rendered for the right provider.
jest.mock("./openrouter-settings", () => ({
  OpenRouterSettings: () => <div data-testid="openrouter-settings" />,
}))
jest.mock("./openrouter-key-management", () => ({
  OpenRouterKeyManagement: () => <div data-testid="openrouter-key-management" />,
}))
jest.mock("./cliproxyapi-settings", () => ({
  CLIProxyAPISettings: () => <div data-testid="cliproxyapi-settings" />,
}))
jest.mock("./provider-import-export", () => ({
  ProviderImportExport: () => <div data-testid="provider-import-export" />,
}))
jest.mock("./oauth-login-button", () => ({
  OAuthLoginButton: ({ providerId }: { providerId: string }) => (
    <div data-testid={`oauth-login-${providerId}`} />
  ),
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
    onCompareClick,
    emptyState,
    hasActiveFilters,
    onClearFilters,
  }: {
    providers: Array<{ id: string; name: string }>
    onSelect: (id: string) => void
    addButton?: React.ReactNode
    onSearchChange: (q: string) => void
    categoryFilter?: string
    onCategoryChange?: (c: string) => void
    onCompareClick?: () => void
    emptyState?: React.ReactNode
    hasActiveFilters?: boolean
    onClearFilters?: () => void
  }) => (
    <div data-testid="provider-sidebar">
      <input
        data-testid="provider-sidebar-search"
        onChange={(e) => onSearchChange(e.target.value)}
      />
      <button data-testid="provider-sidebar-category" onClick={() => onCategoryChange?.("ai")}>
        {categoryFilter ?? "all"}
      </button>
      <button
        data-testid="provider-sidebar-category-custom"
        onClick={() => onCategoryChange?.("custom")}
      >
        custom-filter
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
      {onCompareClick && (
        <button data-testid="mock-compare" onClick={onCompareClick}>
          compare
        </button>
      )}
      <div data-testid="provider-sidebar-add">{addButton}</div>
      {/* The empty state now lives INSIDE the rail so the search box and the
          category tabs survive a filtered-to-nothing list. */}
      {providers.length === 0 && (
        <div data-testid="provider-sidebar-empty" data-has-filters={String(!!hasActiveFilters)}>
          {emptyState}
          {onClearFilters && (
            <button data-testid="provider-sidebar-clear-filters" onClick={onClearFilters}>
              clear
            </button>
          )}
        </div>
      )}
    </div>
  ),
}))
jest.mock("./provider-empty-state", () => ({
  ProviderEmptyState: ({
    onAddProvider,
    importButton,
  }: {
    onAddProvider: () => void
    importButton?: React.ReactNode
  }) => (
    <div>
      <button data-testid="provider-empty-state" onClick={onAddProvider}>
        add-from-empty
      </button>
      {importButton}
    </div>
  ),
}))
jest.mock("./provider-onboarding-banner", () => ({
  ProviderOnboardingBanner: ({
    onScrollToProvider,
  }: {
    onScrollToProvider?: (id: string) => void
  }) => (
    <button
      data-testid="provider-onboarding-banner"
      onClick={() => onScrollToProvider?.("openai")}
    />
  ),
}))
jest.mock("./provider-compare-dialog", () => ({
  ProviderCompareDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="provider-compare-dialog" /> : null,
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
        data-testid="mock-bedrock-default-chain"
        onClick={() =>
          (props.onBedrockSettingsChange as (s: unknown) => void)({
            authMode: "default-chain",
            region: "us-east-1",
            baseURL: "https://bedrock.example.com",
          })
        }
      >
        bedrock-default
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
      <div data-testid="mock-test-result">
        {props.testResult ? JSON.stringify(props.testResult) : "no-result"}
      </div>
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
        data-testid="mock-reorder-api-keys-empty"
        onClick={() => (props.onReorderApiKeys as (f: number, t: number) => void)(5, 0)}
      >
        reorder-empty
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
        data-testid="mock-models-refresh"
        onClick={() => (props.onRefreshModels as () => void)()}
      >
        refresh
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

beforeEach(() => {
  jest.clearAllMocks()
  mockHookState = makeHookState()
  mockDiscoverySnapshot.mockReturnValue({ models: [] })
  mockOpenRouterRow = { models: [{ id: "or-1", name: "OR Model" }] }
})

describe("ProviderSettings (cognia-next slim port)", () => {
  it("always renders the onboarding banner", () => {
    render(<ProviderSettings />)
    expect(screen.getByTestId("provider-onboarding-banner")).toBeInTheDocument()
  })

  it("renders the empty state inside the rail, keeping its controls reachable", () => {
    render(<ProviderSettings />)
    expect(screen.getByTestId("provider-empty-state")).toBeInTheDocument()
    // The rail itself must survive: replacing it took the search box and the
    // category tabs with it, leaving no way to undo a filter.
    expect(screen.getByTestId("provider-sidebar")).toBeInTheDocument()
    expect(screen.getByTestId("provider-sidebar-search")).toBeInTheDocument()
  })

  it("tells the rail when a filter is what emptied the list", () => {
    render(<ProviderSettings />)
    expect(screen.getByTestId("provider-sidebar-empty")).toHaveAttribute(
      "data-has-filters",
      "false"
    )

    fireEvent.click(screen.getByTestId("provider-sidebar-category-custom"))
    expect(screen.getByTestId("provider-sidebar-empty")).toHaveAttribute("data-has-filters", "true")

    // …and clearing gets the user back out of the dead end.
    fireEvent.click(screen.getByTestId("provider-sidebar-clear-filters"))
    expect(screen.getByTestId("provider-sidebar-empty")).toHaveAttribute(
      "data-has-filters",
      "false"
    )
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

  it("runs the previously dormant batch verification flow for eligible enabled providers", async () => {
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
      selectedProviderId: "openai",
    })
    mockHookState.providerSettings.openai = {
      providerId: "openai",
      enabled: true,
      apiKey: "sk-openai",
      defaultModel: "gpt-4o",
    }
    mockHookState.testProvider.mockResolvedValue({
      success: true,
      outcome: "verified",
    })

    const headerActionsTarget = document.createElement("div")
    document.body.append(headerActionsTarget)
    const { container } = render(<ProviderSettings headerActionsTarget={headerActionsTarget} />)
    const verifyButton = within(headerActionsTarget).getByTestId("verify-enabled-providers")

    expect(container).not.toContainElement(verifyButton)
    fireEvent.click(verifyButton)

    await waitFor(() => expect(mockHookState.testProvider).toHaveBeenCalledWith("openai"))
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

  describe("provider-specific panels (previously built but unmounted)", () => {
    const selectProvider = (id: string, name: string) => {
      mockHookState = makeHookState({
        filteredProviders: [[id, { name, defaultModel: "m" }]],
        selectedProviderId: id,
      })
      render(<ProviderSettings />)
    }

    // These panels are `next/dynamic`, which this file's loader stub resolves on
    // a microtask — hence findBy rather than getBy.
    it("mounts the OpenRouter settings and key-management panels for openrouter", async () => {
      selectProvider("openrouter", "OpenRouter")
      expect(await screen.findByTestId("openrouter-settings")).toBeInTheDocument()
      expect(await screen.findByTestId("openrouter-key-management")).toBeInTheDocument()
    })

    it("mounts the CLIProxyAPI panel for cliproxyapi", async () => {
      selectProvider("cliproxyapi", "CLIProxyAPI")
      expect(await screen.findByTestId("cliproxyapi-settings")).toBeInTheDocument()
    })

    it("does not leak a provider-specific panel onto an unrelated provider", async () => {
      selectProvider("openai", "OpenAI")
      await screen.findByTestId("provider-import-export")
      expect(screen.queryByTestId("openrouter-settings")).not.toBeInTheDocument()
      expect(screen.queryByTestId("openrouter-key-management")).not.toBeInTheDocument()
      expect(screen.queryByTestId("cliproxyapi-settings")).not.toBeInTheDocument()
    })

    it("offers the OAuth login for the selected built-in provider", () => {
      // The button self-gates on the catalog's `supportsOAuth`, so it is mounted
      // for every built-in and decides for itself whether to render.
      selectProvider("openai", "OpenAI")
      expect(screen.getByTestId("oauth-login-openai")).toBeInTheDocument()
    })

    it("exposes provider config import/export from the sidebar header", async () => {
      selectProvider("openai", "OpenAI")
      expect(await screen.findByTestId("provider-import-export")).toBeInTheDocument()
    })

    it("offers import as a way out of the empty state", async () => {
      mockHookState = makeHookState({})
      render(<ProviderSettings />)
      expect(screen.getByTestId("provider-empty-state")).toBeInTheDocument()
      // The `importButton` slot existed on ProviderEmptyState but was never
      // passed, so the empty state offered no way to bring a config in.
      // findAll: the rail header carries one too.
      expect((await screen.findAllByTestId("provider-import-export")).length).toBeGreaterThan(0)
    })
  })

  it("keeps a local provider inside the shared detail shell", async () => {
    mockHookState = makeHookState({
      filteredProviders: [["ollama", { name: "Ollama", defaultModel: "" }]],
      selectedProviderId: "ollama",
    })
    const { findByTestId } = render(<ProviderSettings />)

    // The local dashboard used to REPLACE the whole panel, so a local provider
    // lost its header, enable switch, default badge and status — two
    // incompatible detail shells behind one list.
    expect(await findByTestId("local-provider-settings")).toBeInTheDocument()
    expect(screen.getByTestId("provider-detail-panel")).toHaveAttribute(
      "data-provider-id",
      "ollama"
    )
  })

  it("omits the tabs that do not apply to a local provider", async () => {
    mockHookState = makeHookState({
      filteredProviders: [["ollama", { name: "Ollama", defaultModel: "" }]],
      selectedProviderId: "ollama",
    })
    const { findByTestId } = render(<ProviderSettings />)
    await findByTestId("local-provider-settings")

    // A keyless local engine has no cloud model list, per-token cost or routing.
    expect(screen.getByTestId("provider-detail-models-tab")).toBeEmptyDOMElement()
    expect(screen.getByTestId("provider-detail-cost-tab")).toBeEmptyDOMElement()
    expect(screen.getByTestId("provider-detail-advanced-tab")).toBeEmptyDOMElement()
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
    mockHookState.providerSettings.deepseek = {
      providerId: "deepseek",
      enabled: true,
      apiKey: "sk-deepseek",
      defaultModel: "deepseek-chat",
    }
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

    // Deleting drops saved credentials irreversibly, so the first click only
    // asks; nothing is removed until the confirmation is accepted.
    fireEvent.click(screen.getByTestId("mock-delete-provider"))
    expect(mockHookState.removeCustomProvider).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("confirm-delete-custom-provider"))
    expect(mockHookState.removeCustomProvider).toHaveBeenCalledWith("my-custom")
    expect(mockSetSelectedProviderId).toHaveBeenCalledWith(null)
  })

  it("abandons a custom-provider deletion when the confirmation is dismissed", () => {
    mockHookState = makeHookState({
      visibleCustomProviderIds: ["my-custom"],
      customProviders: { "my-custom": { customName: "My Custom" } },
      selectedProviderId: "my-custom",
    })
    render(<ProviderSettings />)

    fireEvent.click(screen.getByTestId("mock-delete-provider"))
    fireEvent.click(screen.getByTestId("cancel-delete-custom-provider"))
    expect(mockHookState.removeCustomProvider).not.toHaveBeenCalled()
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
    // "Refresh models" must actually re-fetch the catalog. It used to call
    // `testProvider`, which only writes discoveredModels on the bedrock branch,
    // so for every other provider the button changed no models at all.
    fireEvent.click(screen.getByTestId("mock-models-refresh"))
    expect(mockSyncModelsDev).toHaveBeenCalled()
    expect(mockHookState.testProvider).not.toHaveBeenCalled()
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
    // Built-in catalog metadata classifies OpenAI as an AI provider, so the
    // category filter keeps it visible.
    expect(screen.getByTestId("provider-sidebar-item-openai")).toBeInTheDocument()
    expect(screen.queryByTestId("provider-empty-state")).not.toBeInTheDocument()
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

  it("renders the parameters placeholder when no settings exist for the selected provider", () => {
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
      selectedProviderId: "openai",
    })
    render(<ProviderSettings />)
    const advancedTab = screen.getByTestId("provider-detail-advanced-tab")
    expect(advancedTab.querySelector('[data-tab="parameters"]')).toHaveTextContent(
      "Configure this provider in the Config tab to enable parameters."
    )
  })

  it("routes the Health tab test connection through the hook", () => {
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
      selectedProviderId: "openai",
    })
    render(<ProviderSettings />)
    const healthTrigger = screen
      .getByTestId("provider-detail-advanced-tab")
      .querySelector('[data-value="health"]')
    expect(healthTrigger).toBeTruthy()
    fireEvent.click(healthTrigger as Element)
    fireEvent.click(screen.getByTestId("mock-health-test"))
    expect(mockHookState.testProvider).toHaveBeenCalledWith("openai")
  })

  it("renders the custom-provider edit flow", () => {
    mockHookState = makeHookState({
      visibleCustomProviderIds: ["my-custom"],
      customProviders: {
        "my-custom": {
          customName: "My Custom",
          baseURL: "https://example.com",
          apiKey: "sk-custom-123",
          defaultModel: "x-1",
          customModels: ["x-1"],
          apiProtocol: "openai",
        },
      },
      selectedProviderId: "my-custom",
    })
    render(<ProviderSettings />)
    fireEvent.click(screen.getByTestId("custom-provider-edit"))
    expect(screen.getByTestId("custom-provider-dialog")).toBeInTheDocument()
  })

  it("renders the unknown-provider placeholder for a stale selection", () => {
    mockHookState = makeHookState({
      filteredProviders: [],
      selectedProviderId: "deleted-provider",
    })
    render(<ProviderSettings />)
    expect(screen.getByTestId("provider-detail-config-tab")).toHaveTextContent(
      "Unknown provider type."
    )
  })

  it("opens the QuickAdd dialog from the sidebar add button", async () => {
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
      selectedProviderId: "openai",
    })
    const { findByTestId } = render(<ProviderSettings />)
    fireEvent.click(screen.getByTestId("provider-sidebar-add").querySelector("button") as Element)
    expect(await findByTestId("quick-add-provider-dialog")).toBeInTheDocument()
  })

  it("routes the onboarding banner scroll action and sidebar compare click", () => {
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
      selectedProviderId: "deepseek",
    })
    render(<ProviderSettings />)
    fireEvent.click(screen.getByTestId("provider-onboarding-banner"))
    expect(mockSetSelectedProviderId).toHaveBeenCalledWith("openai")
    fireEvent.click(screen.getByTestId("mock-compare"))
    expect(screen.getByTestId("provider-compare-dialog")).toBeInTheDocument()
  })

  it("selects a provider from the sidebar", () => {
    mockHookState = makeHookState({
      filteredProviders: [
        ["openai", { name: "OpenAI", defaultModel: "gpt-4o" }],
        ["anthropic", { name: "Anthropic", defaultModel: "claude-4-7-sonnet" }],
      ],
      selectedProviderId: "openai",
    })
    render(<ProviderSettings />)
    fireEvent.click(screen.getByTestId("provider-sidebar-item-anthropic"))
    expect(mockSetSelectedProviderId).toHaveBeenCalledWith("anthropic")
  })

  it("toggles the custom-provider API key visibility", () => {
    mockHookState = makeHookState({
      visibleCustomProviderIds: ["my-custom"],
      customProviders: {
        "my-custom": {
          customName: "My Custom",
          baseURL: "https://example.com",
          apiKey: "sk-custom-123",
          defaultModel: "x-1",
          customModels: ["x-1"],
          apiProtocol: "openai",
        },
      },
      selectedProviderId: "my-custom",
    })
    render(<ProviderSettings />)
    const keyInput = screen.getByDisplayValue("sk-custom-123")
    expect(keyInput).toHaveAttribute("type", "password")
    fireEvent.click(screen.getByRole("button", { name: "S" }))
    expect(keyInput).toHaveAttribute("type", "text")
  })

  it("updates the custom-provider default model", async () => {
    mockHookState = makeHookState({
      visibleCustomProviderIds: ["my-custom"],
      customProviders: {
        "my-custom": {
          customName: "My Custom",
          baseURL: "https://example.com",
          apiKey: "sk-custom-123",
          defaultModel: "x-1",
          customModels: ["x-1", "x-2"],
          apiProtocol: "openai",
        },
      },
      selectedProviderId: "my-custom",
    })
    render(<ProviderSettings />)
    fireEvent.click(screen.getByRole("combobox"))
    fireEvent.click(await screen.findByText("x-2"))
    expect(mockHookState.updateCustomProvider).toHaveBeenCalledWith("my-custom", {
      defaultModel: "x-2",
    })
  })

  it("renders the custom-provider inline config with missing fields and model metadata", async () => {
    mockHookState = makeHookState({
      visibleCustomProviderIds: ["sparse"],
      customProviders: {
        sparse: {
          customName: "Sparse",
          customModels: ["m1"],
          customModelMetadata: { m1: { name: "Model One" } },
          apiProtocol: "openai",
        },
      },
      selectedProviderId: "sparse",
    })
    render(<ProviderSettings />)
    fireEvent.click(screen.getByRole("combobox"))
    expect(await screen.findByText("Model One")).toBeInTheDocument()
  })

  it("filters the sidebar to custom providers and handles test errors", () => {
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
      visibleCustomProviderIds: ["c1", "missing"],
      customProviders: {
        c1: { customName: "Custom One", baseURL: "u1", defaultModel: "m1", apiKey: "k1" },
      },
      customTestResults: { c1: "error" },
      selectedProviderId: "c1",
    })
    render(<ProviderSettings />)
    fireEvent.click(screen.getByTestId("provider-sidebar-category-custom"))
    expect(screen.getByTestId("provider-sidebar-item-c1")).toBeInTheDocument()
    expect(screen.queryByTestId("provider-sidebar-item-openai")).not.toBeInTheDocument()
  })

  it("maps a successful connection test result to the Config tab", async () => {
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
      selectedProviderId: "openai",
    })
    mockHookState.testResults.openai = { success: true, latency_ms: 120, message: "ok" }
    mockHookState.testProvider = jest.fn(() =>
      Promise.resolve({ success: true, latency_ms: 120, message: "ok" })
    )
    render(<ProviderSettings />)
    expect(screen.getByTestId("mock-test-result")).toHaveTextContent("true")
    fireEvent.click(screen.getByTestId("mock-test-connection"))
    await waitFor(() => expect(mockHookState.testProvider).toHaveBeenCalledWith("openai"))
  })

  it("handles Bedrock default-chain auth and missing API key pools", () => {
    mockHookState = makeHookState({
      filteredProviders: [["bedrock", { name: "Amazon Bedrock", defaultModel: "nova-lite" }]],
      selectedProviderId: "bedrock",
    })
    render(<ProviderSettings />)
    fireEvent.click(screen.getByTestId("mock-bedrock-default-chain"))
    expect(mockSetProviderConfig).toHaveBeenCalledWith(
      "bedrock",
      expect.objectContaining({
        bedrock: {
          authMode: "default-chain",
          region: "us-east-1",
          baseURL: "https://bedrock.example.com",
        },
        apiKey: undefined,
      })
    )
    fireEvent.click(screen.getByTestId("mock-reorder-api-keys-empty"))
    expect(mockSetProviderConfig).not.toHaveBeenLastCalledWith(
      "bedrock",
      expect.objectContaining({ apiKeys: expect.any(Array) })
    )
  })

  it("enriches built-in models from the discovery snapshot", () => {
    mockDiscoverySnapshot.mockReturnValue({
      models: [
        {
          id: "snap-1",
          name: "Snapshot Model",
          contextLength: 100,
          maxOutputTokens: 50,
          supportsTools: true,
          supportsVision: true,
          supportsStreaming: false,
          supportsReasoning: false,
          supportsAudio: false,
        },
      ],
    })
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
      selectedProviderId: "openai",
    })
    render(<ProviderSettings />)
    expect(mockDiscoverySnapshot).toHaveBeenCalled()
  })

  it("folds discovered models into the default-model options for non-OpenRouter providers", () => {
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
      selectedProviderId: "openai",
    })
    mockHookState.providerSettings.openai = {
      discoveredModels: [{ id: "disc-1", name: "Discovered" }],
    }
    render(<ProviderSettings />)
    expect(screen.getByTestId("provider-detail-panel")).toHaveAttribute(
      "data-provider-id",
      "openai"
    )
  })

  it("maps a failed connection test result to the Config tab", async () => {
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
      selectedProviderId: "openai",
    })
    mockHookState.testResults.openai = { success: false, latency_ms: 0, message: "bad key" }
    mockHookState.testProvider = jest.fn(() =>
      Promise.resolve({ success: false, latency_ms: 0, message: "bad key" })
    )
    render(<ProviderSettings />)
    expect(screen.getByTestId("mock-test-result")).toHaveTextContent("false")
    fireEvent.click(screen.getByTestId("mock-test-connection"))
    await waitFor(() => expect(mockHookState.testProvider).toHaveBeenCalledWith("openai"))
  })

  it("routes a failed Health tab test connection", async () => {
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
      selectedProviderId: "openai",
    })
    mockHookState.testResults.openai = { success: false, message: "fail" }
    mockHookState.testProvider = jest.fn(() => Promise.resolve({ success: false, message: "fail" }))
    render(<ProviderSettings />)
    const healthTrigger = screen
      .getByTestId("provider-detail-advanced-tab")
      .querySelector('[data-value="health"]')
    fireEvent.click(healthTrigger as Element)
    fireEvent.click(screen.getByTestId("mock-health-test"))
    await waitFor(() => expect(mockHookState.testProvider).toHaveBeenCalledWith("openai"))
  })

  it("adds and removes API keys when no key pool exists", () => {
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
      selectedProviderId: "openai",
    })
    render(<ProviderSettings />)
    fireEvent.click(screen.getByTestId("mock-add-api-key"))
    expect(mockSetProviderConfig).toHaveBeenCalledWith("openai", { apiKeys: ["k2"] })
    fireEvent.click(screen.getByTestId("mock-remove-api-key"))
    expect(mockSetProviderConfig).toHaveBeenCalledWith("openai", { apiKeys: [] })
  })

  it("renders a successful custom-provider connection status", () => {
    mockHookState = makeHookState({
      visibleCustomProviderIds: ["c1"],
      customProviders: {
        c1: { customName: "Custom One", baseURL: "u1", defaultModel: "m1", apiKey: "k1" },
      },
      customTestResults: { c1: "success" },
      selectedProviderId: "c1",
    })
    render(<ProviderSettings />)
    expect(screen.getByTestId("provider-detail-panel")).toHaveAttribute("data-provider-id", "c1")
  })

  it("enriches built-in models across true and false capability branches", () => {
    mockDiscoverySnapshot.mockReturnValue({
      models: [
        {
          id: "dev-1",
          name: "With meta",
          contextLength: 100,
          maxOutputTokens: 50,
          supportsTools: true,
          supportsVision: true,
          supportsStreaming: true,
          supportsReasoning: true,
          supportsAudio: true,
        },
        {
          id: "no-meta",
          name: "Without meta",
          contextLength: 100,
          maxOutputTokens: 50,
          supportsTools: false,
          supportsVision: false,
          supportsStreaming: false,
          supportsReasoning: false,
          supportsAudio: false,
        },
      ],
    })
    mockHookState = makeHookState({
      filteredProviders: [["openai", { name: "OpenAI", defaultModel: "gpt-4o" }]],
      selectedProviderId: "openai",
    })
    render(<ProviderSettings />)
    expect(mockDiscoverySnapshot).toHaveBeenCalled()
  })

  it("handles an OpenRouter selection with no live catalog row", () => {
    mockOpenRouterRow = undefined
    mockHookState = makeHookState({
      filteredProviders: [["openrouter", { name: "OpenRouter", defaultModel: "openrouter/auto" }]],
      selectedProviderId: "openrouter",
    })
    render(<ProviderSettings />)
    expect(screen.getByTestId("provider-detail-panel")).toHaveAttribute(
      "data-provider-id",
      "openrouter"
    )
  })
})

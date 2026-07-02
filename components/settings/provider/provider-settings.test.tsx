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
import { ProviderSettings, deriveStatus } from "./provider-settings"

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
  QuickAddProviderDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="quick-add-provider-dialog" /> : null,
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
    isDefault,
    onSetDefault,
  }: {
    provider: { id: string; name: string } | null
    configTab?: React.ReactNode
    isDefault?: boolean
    onSetDefault?: () => void
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
      <div data-testid="provider-detail-config-tab">{configTab}</div>
    </div>
  ),
}))
jest.mock("./provider-sidebar", () => ({
  ProviderSidebar: ({
    providers,
    onSelect,
    addButton,
    onSearchChange,
  }: {
    providers: Array<{ id: string; name: string }>
    onSelect: (id: string) => void
    addButton?: React.ReactNode
    onSearchChange: (q: string) => void
  }) => (
    <div data-testid="provider-sidebar">
      <input
        data-testid="provider-sidebar-search"
        onChange={(e) => onSearchChange(e.target.value)}
      />
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
jest.mock("./provider-config-tab", () => ({ ProviderConfigTab: () => null }))
jest.mock("./provider-models-tab", () => ({ ProviderModelsTab: () => null }))
jest.mock("./provider-cost-tab", () => ({ ProviderCostTab: () => null }))
jest.mock("./provider-parameters-tab", () => ({ ProviderParametersTab: () => null }))
jest.mock("./routing-tab", () => ({ RoutingTab: () => null }))
jest.mock("./health-tab", () => ({ HealthTab: () => null }))
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
})

describe("deriveStatus", () => {
  it("returns not-configured when neither an apiKey nor a baseURL is set", () => {
    expect(deriveStatus(undefined, undefined, undefined)).toBe("not-configured")
  })

  it("returns limited when the test outcome is 'limited', even though testOk is true", () => {
    expect(deriveStatus("sk-x", undefined, true, "limited")).toBe("limited")
  })

  it("prioritizes limited over a failed testOk (outcome is the more specific signal)", () => {
    expect(deriveStatus("sk-x", undefined, false, "limited")).toBe("limited")
  })

  it("returns error when the test failed and outcome is not limited", () => {
    expect(deriveStatus("sk-x", undefined, false)).toBe("error")
  })

  it("returns connected when the test succeeded outright", () => {
    expect(deriveStatus("sk-x", undefined, true)).toBe("connected")
  })

  it("returns warning when configured but never tested", () => {
    expect(deriveStatus("sk-x", undefined, undefined)).toBe("warning")
  })

  it("treats a configured baseURL (no key) the same as a configured key", () => {
    expect(deriveStatus(undefined, "https://x.example.com", undefined)).toBe("warning")
  })
})

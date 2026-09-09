/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import type { UseProviderSettingsResult } from "@/hooks/settings/use-provider-settings"

import { ProviderDetailHost, type ProviderDetailHostProps } from "./provider-detail-host"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

// The panel itself is covered by its own suite. Here it is a probe that reports
// which slot got which component, because the three-way branch that fills those
// slots is the whole point of this module.
jest.mock("./provider-detail-panel", () => ({
  ProviderDetailPanel: (props: Record<string, unknown>) => (
    <div data-testid="panel" data-connection-status={String(props.connectionStatus)}>
      <div data-testid="slot-connect">{props.connectTab as React.ReactNode}</div>
      <div data-testid="slot-models">{props.modelsTab as React.ReactNode}</div>
      <div data-testid="slot-usage">
        {props.usageTab === undefined ? "no-usage-tab" : (props.usageTab as React.ReactNode)}
      </div>
      <div data-testid="slot-diagnostics">{props.diagnosticsTab as React.ReactNode}</div>
      <div data-testid="panel-flags">
        {[
          props.isDefault ? "default" : "",
          props.onDelete ? "deletable" : "",
          props.onBack ? "backable" : "",
          props.onSetDefault ? "settable" : "",
        ]
          .filter(Boolean)
          .join(",")}
      </div>
    </div>
  ),
}))

// `jest.mock` factories are hoisted above every const in the file, so the
// stub has to be built inside each factory rather than shared from one.
jest.mock("./provider-config-tab", () => ({
  ProviderConfigTab: () => <div data-testid="config-tab" />,
}))
jest.mock("./provider-models-tab", () => ({
  ProviderModelsTab: () => <div data-testid="models-tab" />,
}))
jest.mock("./provider-cost-tab", () => ({ ProviderCostTab: () => <div data-testid="cost-tab" /> }))
jest.mock("./provider-diagnostics-tab", () => ({
  ProviderDiagnosticsTab: () => <div data-testid="diagnostics-tab" />,
}))
jest.mock("./provider-parameters-tab", () => ({
  ProviderParametersTab: () => <div data-testid="parameters-tab" />,
}))
jest.mock("./provider-custom-inline-config", () => ({
  CustomProviderInlineConfig: () => <div data-testid="custom-inline-config" />,
}))
jest.mock("./provider-setup-checklist", () => ({
  ProviderSetupChecklist: () => <div data-testid="setup-checklist" />,
}))
jest.mock("./oauth-login-button", () => ({
  OAuthLoginButton: () => <div data-testid="oauth-login" />,
}))
jest.mock("./key-login-row", () => ({ KeyLoginRow: () => <div data-testid="key-login" /> }))
jest.mock("./local-provider-settings", () => ({
  LocalProviderSettings: () => <div data-testid="local-settings" />,
}))
jest.mock("./local-provider-model-manager", () => ({
  LocalProviderModelManager: () => <div data-testid="local-model-manager" />,
}))
jest.mock("./openrouter-settings", () => ({
  OpenRouterSettings: () => <div data-testid="openrouter-settings" />,
}))
jest.mock("./openrouter-key-management", () => ({
  OpenRouterKeyManagement: () => <div data-testid="openrouter-keys" />,
}))
jest.mock("./cliproxyapi-settings", () => ({
  CLIProxyAPISettings: () => <div data-testid="cliproxyapi-settings" />,
}))

jest.mock("./provider-status-utils", () => ({ deriveStatus: () => "connected" }))
jest.mock("@cognia/provider-core/providers/provider-parameter-schemas", () => ({
  getSchemaForProvider: () => undefined,
}))
jest.mock("@cognia/provider-types", () => ({
  validateBedrockConnectionSettings: () => ({ valid: true }),
}))

const settings = {
  customTestResults: {},
  customTestMessages: {},
  testResults: {},
  testingProviders: {},
  testingCustomProviders: {},
  customProviders: {},
  updateCustomProvider: jest.fn(),
  setDefaultProvider: jest.fn(),
  testCustomProvider: jest.fn(),
  testProvider: jest.fn(),
} as unknown as UseProviderSettingsResult

const builtIn = {
  id: "openai",
  name: "OpenAI",
  defaultModel: "gpt-4.1",
  models: [{ id: "gpt-4.1" }],
  dashboardUrl: "https://platform.openai.com",
  docsUrl: "https://platform.openai.com/docs",
} as unknown as ProviderDetailHostProps["selectedBuiltIn"]

function renderHost(over: Partial<ProviderDetailHostProps> = {}) {
  const props: ProviderDetailHostProps = {
    selectedId: "openai",
    selectedBuiltIn: builtIn,
    selectedCustom: undefined,
    selectedSettings: undefined,
    selectedName: "OpenAI",
    selectedReadiness: null,
    isCustom: false,
    isLocalProvider: false,
    isEnabled: true,
    canEnable: true,
    enableBlockedReason: undefined,
    canSetDefault: true,
    setDefaultBlockedReason: undefined,
    isDefault: false,
    settings,
    liveProviderHealth: {},
    setProviderConfig: jest.fn(),
    configModelOptions: [],
    enrichedBuiltInModels: [],
    modelsDevLoading: false,
    diagnosticStatusByModel: {},
    configTestResult: null,
    isRefreshingModels: false,
    onRefreshModels: jest.fn(),
    onTestConnection: jest.fn(),
    onEditCustom: jest.fn(),
    onPersistLocalModels: jest.fn(),
    onRequestDelete: jest.fn(),
    ...over,
  }
  return { ...render(<ProviderDetailHost {...props} />), props }
}

describe("ProviderDetailHost", () => {
  describe("a built-in provider", () => {
    it("fills the connect slot with the shared config tab", () => {
      renderHost()
      expect(screen.getByTestId("slot-connect")).toContainElement(screen.getByTestId("config-tab"))
    })

    // Both panels shipped with a catalog entry and a full settings schema but
    // were never mounted, so every field they expose was unreachable. They
    // self-gate, so mounting them for every built-in is safe.
    it("always mounts the OAuth and guided-key rows so they can self-gate", () => {
      renderHost()
      expect(screen.getByTestId("oauth-login")).toBeInTheDocument()
      expect(screen.getByTestId("key-login")).toBeInTheDocument()
    })

    // These panels are `next/dynamic`, so they arrive a tick after mount and
    // need an async finder rather than a synchronous get.
    it("mounts the OpenRouter panels only for openrouter", async () => {
      const { unmount } = renderHost()
      expect(screen.queryByTestId("openrouter-settings")).not.toBeInTheDocument()
      unmount()

      renderHost({ selectedId: "openrouter" })
      expect(await screen.findByTestId("openrouter-settings")).toBeInTheDocument()
      expect(await screen.findByTestId("openrouter-keys")).toBeInTheDocument()
    })

    it("mounts the CLIProxyAPI panel only for cliproxyapi", async () => {
      const { unmount } = renderHost()
      expect(screen.queryByTestId("cliproxyapi-settings")).not.toBeInTheDocument()
      unmount()

      renderHost({ selectedId: "cliproxyapi" })
      expect(await screen.findByTestId("cliproxyapi-settings")).toBeInTheDocument()
    })

    it("gets the models tab and a usage tab", () => {
      renderHost()
      expect(screen.getByTestId("models-tab")).toBeInTheDocument()
      expect(screen.getByTestId("cost-tab")).toBeInTheDocument()
    })
  })

  describe("a custom provider", () => {
    const custom = {
      id: "my-gateway",
      customName: "My Gateway",
      apiProtocol: "openai",
      customModels: ["a"],
    } as unknown as ProviderDetailHostProps["selectedCustom"]

    it("swaps the connect slot for the inline custom form", () => {
      renderHost({ isCustom: true, selectedCustom: custom, selectedBuiltIn: undefined })
      expect(screen.getByTestId("custom-inline-config")).toBeInTheDocument()
      expect(screen.queryByTestId("config-tab")).not.toBeInTheDocument()
    })

    // A custom provider's model list is managed in its own editor dialog, so
    // the models tab explains that rather than rendering an empty grid.
    it("explains that models are managed elsewhere", () => {
      renderHost({ isCustom: true, selectedCustom: custom, selectedBuiltIn: undefined })
      expect(screen.getByText("customProviderModelsManaged")).toBeInTheDocument()
      expect(screen.queryByTestId("models-tab")).not.toBeInTheDocument()
    })

    it("is the only kind that can be deleted", () => {
      const { unmount } = renderHost({
        isCustom: true,
        selectedCustom: custom,
        selectedBuiltIn: undefined,
      })
      expect(screen.getByTestId("panel-flags")).toHaveTextContent("deletable")
      unmount()

      renderHost()
      expect(screen.getByTestId("panel-flags")).not.toHaveTextContent("deletable")
    })
  })

  describe("a local engine", () => {
    const local = { isLocalProvider: true, selectedId: "ollama" }

    it("gets its own dashboard in the connect slot", async () => {
      renderHost({ ...local, selectedBuiltIn: undefined })
      expect(await screen.findByTestId("local-settings")).toBeInTheDocument()
      expect(screen.queryByTestId("config-tab")).not.toBeInTheDocument()
    })

    it("gets the local model manager instead of the catalog grid", async () => {
      renderHost(local)
      expect(await screen.findByTestId("local-model-manager")).toBeInTheDocument()
      expect(screen.queryByTestId("models-tab")).not.toBeInTheDocument()
    })

    // Recorded here so the change in a later commit is a deliberate edit to a
    // pinned expectation rather than a silent flip. Token counts are written
    // for local engines and nothing renders them today.
    it("has no usage tab today", () => {
      renderHost(local)
      expect(screen.getByTestId("slot-usage")).toHaveTextContent("no-usage-tab")
    })
  })

  describe("an unknown selection", () => {
    it("says so instead of rendering a blank pane", () => {
      renderHost({ selectedBuiltIn: undefined, selectedCustom: undefined, isCustom: false })
      expect(screen.getByTestId("unknown-provider-placeholder")).toBeInTheDocument()
    })
  })

  describe("header affordances", () => {
    it("marks the app default provider", () => {
      renderHost({ isDefault: true })
      expect(screen.getByTestId("panel-flags")).toHaveTextContent("default")
    })

    it("withholds set-as-default when the provider cannot be one", () => {
      renderHost({ canSetDefault: false })
      expect(screen.getByTestId("panel-flags")).not.toHaveTextContent("settable")
    })

    // The back arrow only exists in the mobile push-navigation layout. A split
    // layout passes no handler and the panel renders no arrow.
    it("offers a back arrow only when the caller supplies one", () => {
      const { unmount } = renderHost()
      expect(screen.getByTestId("panel-flags")).not.toHaveTextContent("backable")
      unmount()

      renderHost({ onBack: jest.fn() })
      expect(screen.getByTestId("panel-flags")).toHaveTextContent("backable")
    })
  })

  it("always renders a diagnostics tab, whatever the provider kind", () => {
    const { unmount } = renderHost()
    expect(screen.getByTestId("diagnostics-tab")).toBeInTheDocument()
    unmount()

    renderHost({ isLocalProvider: true, selectedId: "ollama" })
    expect(screen.getByTestId("diagnostics-tab")).toBeInTheDocument()
  })

  // Parameters was a tab of its own holding one collapsible block. It is now
  // the last block of Connect, for every provider kind.
  it("puts the request parameters at the end of the connect slot", () => {
    renderHost()
    expect(screen.getByTestId("slot-connect")).toContainElement(
      screen.getByTestId("parameters-tab")
    )
  })

  it("gives a custom endpoint and a local engine the parameters block too", async () => {
    const { unmount } = renderHost({
      isCustom: true,
      selectedBuiltIn: undefined,
      selectedCustom: { id: "gw", customName: "GW" } as never,
    })
    expect(screen.getByTestId("slot-connect")).toContainElement(
      screen.getByTestId("parameters-tab")
    )
    unmount()

    renderHost({ isLocalProvider: true, selectedId: "ollama", selectedBuiltIn: undefined })
    expect(await screen.findByTestId("local-settings")).toBeInTheDocument()
    expect(screen.getByTestId("slot-connect")).toContainElement(
      screen.getByTestId("parameters-tab")
    )
  })

  // The placeholder branch is the one connect case with no parameters block:
  // there is no provider to configure.
  it("gives the unknown-provider placeholder no parameters block", () => {
    renderHost({ selectedBuiltIn: undefined, selectedCustom: undefined, isCustom: false })
    expect(screen.queryByTestId("parameters-tab")).not.toBeInTheDocument()
  })

  it("shows the setup checklist once readiness has been derived", () => {
    const { unmount } = renderHost()
    expect(screen.queryByTestId("setup-checklist")).not.toBeInTheDocument()
    unmount()

    renderHost({
      selectedReadiness: {
        setupChecklist: [],
      } as unknown as ProviderDetailHostProps["selectedReadiness"],
    })
    expect(screen.getByTestId("setup-checklist")).toBeInTheDocument()
  })
})

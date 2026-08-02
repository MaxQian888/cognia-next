/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { ProviderDetailPanel } from "./provider-detail-panel"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      "detailPanel.emptyTitle": "No Provider Selected",
      "detailPanel.emptyDescription": "Select a provider to configure, or add a new one",
      "detailPanel.testButton": "Test",
      "detailPanel.modelsAvailable": "{count} models available",
      "detailPanel.connected": "Connected",
      "detailPanel.connectionFailed": "Error",
      "detailPanel.defaultBadge": "Default",
      "detailPanel.notConfigured": "Not configured",
      "detailPanel.notConfiguredHint": "Add credentials",
      "detailPanel.setDefault": "Set as default",
      "detailPanel.setDefaultAria": "Use this provider for new chats by default",
      "detailPanel.warning": "Warning",
      "detailPanel.warningHint": "Configured but not verified",
      "sidebar.statusUntested": "Not tested",
      verificationLimitedShort: "Limited",
      delete: "Delete",
      "tabs.config": "Config",
      "tabs.models": "Models",
      "tabs.cost": "Cost",
      "tabs.diagnostics": "Diagnostics",
      "tabs.advanced": "Advanced",
    }
    return map[key] ?? key
  },
}))

describe("ProviderDetailPanel", () => {
  it("shows empty state when no provider is selected", () => {
    render(<ProviderDetailPanel provider={null} />)
    expect(screen.getByText("No Provider Selected")).toBeInTheDocument()
    expect(screen.getByText("Select a provider to configure, or add a new one")).toBeInTheDocument()
  })

  it("shows the provider header and every tab whose slot is filled", () => {
    render(
      <ProviderDetailPanel
        provider={{ id: "openai", name: "OpenAI", icon: "🤖", modelCount: 12 }}
        onToggleEnabled={jest.fn()}
        isEnabled={true}
        configTab={<div />}
        modelsTab={<div />}
        costTab={<div />}
        diagnosticsTab={<div />}
        advancedTab={<div />}
      />
    )
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(
      screen.getByText("OpenAI").closest("div")?.parentElement?.querySelector("img")
    ).toHaveAttribute("src", "/icons/lobe/openai.svg")
    expect(screen.queryByText("🤖")).not.toBeInTheDocument()
    expect(screen.getByText("Config")).toBeInTheDocument()
    expect(screen.getByText("Models")).toBeInTheDocument()
    expect(screen.getByText("Cost")).toBeInTheDocument()
    expect(screen.getByText("Diagnostics")).toBeInTheDocument()
    expect(screen.getByText("Advanced")).toBeInTheDocument()
  })

  it("hides the tabs whose slots are empty, keeping the shared header", () => {
    // Lets a local inference engine live in this shell (header, enable switch,
    // default badge, status) while showing only the Config tab that applies,
    // instead of replacing the whole panel with a different layout.
    render(
      <ProviderDetailPanel
        provider={{ id: "ollama", name: "Ollama", icon: "🦙" }}
        onToggleEnabled={jest.fn()}
        isEnabled={true}
        configTab={<div data-testid="local-config" />}
      />
    )
    expect(screen.getByText("Ollama")).toBeInTheDocument()
    expect(screen.getByText("Config")).toBeInTheDocument()
    expect(screen.getByTestId("local-config")).toBeInTheDocument()
    expect(screen.queryByText("Models")).not.toBeInTheDocument()
    expect(screen.queryByText("Cost")).not.toBeInTheDocument()
    expect(screen.queryByText("Diagnostics")).not.toBeInTheDocument()
    expect(screen.queryByText("Advanced")).not.toBeInTheDocument()
  })

  describe("tab layout", () => {
    // Radix activates a tab on mousedown, not click.
    const openModels = () => fireEvent.mouseDown(screen.getByRole("tab", { name: "Models" }))

    it("lets the tab triggers share the pane width instead of overflowing it", () => {
      const { container } = render(
        <ProviderDetailPanel
          provider={{ id: "openai", name: "OpenAI" }}
          configTab={<div />}
          modelsTab={<div />}
        />
      )
      const list = container.querySelector('[data-slot="tabs-list"]')
      expect(list).toHaveClass("w-full", "min-w-0")
      container
        .querySelectorAll('[data-slot="tabs-trigger"]')
        .forEach((trigger) => expect(trigger).toHaveClass("min-w-0", "flex-1"))
    })

    it("keeps the Models tab out of the shared scroller so it can pin its own toolbar", () => {
      const { container } = render(
        <ProviderDetailPanel
          provider={{ id: "openai", name: "OpenAI" }}
          configTab={<div data-testid="config-body" />}
          modelsTab={<div data-testid="models-body" />}
        />
      )
      const scroller = container.querySelector('[data-slot="scroll-area"]')
      expect(scroller).toContainElement(screen.getByTestId("config-body"))

      openModels()
      expect(container.querySelector('[data-slot="scroll-area"]')).not.toContainElement(
        screen.getByTestId("models-body")
      )
    })

    it("takes the shared scroller out of the layout while Models is active", () => {
      // Left in place it claimed half the pane as an empty box, because every
      // one of its tab bodies is inactive on the Models tab.
      const { container } = render(
        <ProviderDetailPanel
          provider={{ id: "openai", name: "OpenAI" }}
          configTab={<div />}
          modelsTab={<div />}
        />
      )
      expect(container.querySelector('[data-slot="scroll-area"]')).not.toHaveClass("hidden")
      openModels()
      expect(container.querySelector('[data-slot="scroll-area"]')).toHaveClass("hidden")
    })

    it("falls back to Config when the active tab's slot disappears", () => {
      // Selecting a local engine drops the Models slot; the panel must not sit
      // on a tab that no longer has a trigger to leave it.
      const { rerender } = render(
        <ProviderDetailPanel
          provider={{ id: "openai", name: "OpenAI" }}
          configTab={<div data-testid="config-body" />}
          modelsTab={<div data-testid="models-body" />}
        />
      )
      openModels()
      expect(screen.getByTestId("models-body")).toBeInTheDocument()

      rerender(
        <ProviderDetailPanel
          provider={{ id: "ollama", name: "Ollama" }}
          configTab={<div data-testid="config-body" />}
        />
      )
      expect(screen.getByTestId("config-body")).toBeInTheDocument()
      expect(screen.queryByTestId("models-body")).not.toBeInTheDocument()
    })
  })

  it("preserves a supplied legacy icon for an unknown provider", () => {
    render(<ProviderDetailPanel provider={{ id: "custom-provider", name: "Custom", icon: "🧪" }} />)

    expect(screen.getByText("🧪")).toBeInTheDocument()
  })

  it("shows a green Connected badge for connectionStatus='connected'", () => {
    render(
      <ProviderDetailPanel
        provider={{ id: "openai", name: "OpenAI" }}
        connectionStatus="connected"
      />
    )
    expect(screen.getByText("Connected")).toBeInTheDocument()
  })

  it("shows a red Error badge for connectionStatus='error'", () => {
    render(
      <ProviderDetailPanel provider={{ id: "openai", name: "OpenAI" }} connectionStatus="error" />
    )
    expect(screen.getByText("Error")).toBeInTheDocument()
  })

  it("shows an amber Limited badge for connectionStatus='limited' (not collapsed into Connected)", () => {
    render(
      <ProviderDetailPanel provider={{ id: "openai", name: "OpenAI" }} connectionStatus="limited" />
    )
    expect(screen.getByText("Limited")).toBeInTheDocument()
    expect(screen.queryByText("Connected")).not.toBeInTheDocument()
  })

  it("shows a neutral Not tested badge for configured credentials that have not been verified", () => {
    render(
      <ProviderDetailPanel
        provider={{ id: "openai", name: "OpenAI" }}
        connectionStatus="untested"
      />
    )
    expect(screen.getByText("Not tested")).toBeInTheDocument()
  })

  it("shows the Default badge (and no set-default button) when this provider is the default", () => {
    render(
      <ProviderDetailPanel
        provider={{ id: "deepseek", name: "DeepSeek" }}
        isDefault
        onSetDefault={jest.fn()}
      />
    )
    expect(screen.getByTestId("provider-default-badge")).toHaveTextContent("Default")
    expect(screen.queryByTestId("provider-set-default")).not.toBeInTheDocument()
  })

  it("offers a set-default action for a non-default provider and forwards the click", () => {
    const onSetDefault = jest.fn()
    render(
      <ProviderDetailPanel
        provider={{ id: "deepseek", name: "DeepSeek" }}
        isDefault={false}
        onSetDefault={onSetDefault}
      />
    )
    fireEvent.click(screen.getByTestId("provider-set-default"))
    expect(onSetDefault).toHaveBeenCalledTimes(1)
  })

  it("hides the set-default action when no handler is provided", () => {
    render(<ProviderDetailPanel provider={{ id: "openai", name: "OpenAI" }} />)
    expect(screen.queryByTestId("provider-set-default")).not.toBeInTheDocument()
    expect(screen.queryByTestId("provider-default-badge")).not.toBeInTheDocument()
  })

  it("shows status badges for 'warning' and 'not-configured'", () => {
    const { rerender } = render(
      <ProviderDetailPanel provider={{ id: "openai", name: "OpenAI" }} connectionStatus="warning" />
    )
    expect(screen.getByText("Warning")).toBeInTheDocument()
    rerender(
      <ProviderDetailPanel
        provider={{ id: "openai", name: "OpenAI" }}
        connectionStatus="not-configured"
      />
    )
    expect(screen.getByText("Not configured")).toBeInTheDocument()
  })

  it("renders the custom delete action and forwards the click", () => {
    const onDelete = jest.fn()
    render(
      <ProviderDetailPanel
        provider={{ id: "custom", name: "Custom" }}
        isCustom
        onDelete={onDelete}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it("forwards toggle-enabled changes", () => {
    const onToggleEnabled = jest.fn()
    render(
      <ProviderDetailPanel
        provider={{ id: "openai", name: "OpenAI" }}
        isEnabled={false}
        onToggleEnabled={onToggleEnabled}
      />
    )
    fireEvent.click(screen.getByRole("switch"))
    expect(onToggleEnabled).toHaveBeenCalledWith(true)
  })

  it("prevents enabling a provider until its required configuration is complete", () => {
    const onToggleEnabled = jest.fn()
    render(
      <ProviderDetailPanel
        provider={{ id: "openai", name: "OpenAI" }}
        isEnabled={false}
        canEnable={false}
        onToggleEnabled={onToggleEnabled}
      />
    )

    expect(screen.getByRole("switch")).toBeDisabled()
    fireEvent.click(screen.getByRole("switch"))
    expect(onToggleEnabled).not.toHaveBeenCalled()
  })

  it("renders tab content slots when provided", () => {
    render(
      <ProviderDetailPanel
        provider={{ id: "openai", name: "OpenAI" }}
        configTab={<div>Config content</div>}
      />
    )
    expect(screen.getByText("Config content")).toBeInTheDocument()
  })
})

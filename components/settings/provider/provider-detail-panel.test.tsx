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
      "detailPanel.setDefault": "Set as default",
      "detailPanel.setDefaultAria": "Use this provider for new chats by default",
      verificationLimitedShort: "Limited",
      "tabs.config": "Config",
      "tabs.models": "Models",
      "tabs.cost": "Cost",
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

  it("shows provider header and tabs when provider is selected", () => {
    render(
      <ProviderDetailPanel
        provider={{ id: "openai", name: "OpenAI", icon: "🤖", modelCount: 12 }}
        onToggleEnabled={jest.fn()}
        isEnabled={true}
      />
    )
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(screen.getByText("Config")).toBeInTheDocument()
    expect(screen.getByText("Models")).toBeInTheDocument()
    expect(screen.getByText("Cost")).toBeInTheDocument()
    expect(screen.getByText("Advanced")).toBeInTheDocument()
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

  it("shows no status badge for 'warning' or 'not-configured'", () => {
    const { rerender } = render(
      <ProviderDetailPanel provider={{ id: "openai", name: "OpenAI" }} connectionStatus="warning" />
    )
    expect(screen.queryByText("Connected")).not.toBeInTheDocument()
    expect(screen.queryByText("Error")).not.toBeInTheDocument()
    expect(screen.queryByText("Limited")).not.toBeInTheDocument()
    rerender(
      <ProviderDetailPanel
        provider={{ id: "openai", name: "OpenAI" }}
        connectionStatus="not-configured"
      />
    )
    expect(screen.queryByText("Connected")).not.toBeInTheDocument()
    expect(screen.queryByText("Error")).not.toBeInTheDocument()
    expect(screen.queryByText("Limited")).not.toBeInTheDocument()
  })
})

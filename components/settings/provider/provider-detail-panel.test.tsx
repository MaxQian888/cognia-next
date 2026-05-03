/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { ProviderDetailPanel } from "./provider-detail-panel"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      "detailPanel.emptyTitle": "No Provider Selected",
      "detailPanel.emptyDescription": "Select a provider to configure, or add a new one",
      "detailPanel.testButton": "Test",
      "detailPanel.modelsAvailable": "{count} models available",
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
})

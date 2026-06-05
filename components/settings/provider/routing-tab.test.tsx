import { render, screen } from "@testing-library/react"
import { RoutingTab } from "./routing-tab"

jest.mock("./routing/routing-config-panel", () => ({
  RoutingConfigPanel: () => <div data-testid="routing-config-panel" />,
}))

describe("RoutingTab", () => {
  it("delegates to the global RoutingConfigPanel (placeholder is gone)", () => {
    render(<RoutingTab providerId="openai" providerName="OpenAI" />)
    expect(screen.getByTestId("routing-config-panel")).toBeInTheDocument()
    expect(screen.queryByText(/Coming Soon/)).not.toBeInTheDocument()
  })
})

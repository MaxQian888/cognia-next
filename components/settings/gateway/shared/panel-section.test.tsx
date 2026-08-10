import { render, screen } from "@testing-library/react"

import { GatewayPanelSection, GatewayPanelStack } from "./panel-section"

describe("GatewayPanelSection", () => {
  it("renders the minimal flat section without optional header slots", () => {
    render(<GatewayPanelSection title="Minimal">Body</GatewayPanelSection>)

    expect(screen.getByRole("region", { name: "Minimal" })).toHaveTextContent("Body")
  })

  it("renders a labelled flat section with its metadata and action", () => {
    render(
      <GatewayPanelSection
        title="Listener"
        description="Bind-time settings"
        badge="Restart"
        icon={<span role="img" aria-label="Listener icon" />}
        action={<button type="button">Refresh</button>}
      >
        <p>Fields</p>
      </GatewayPanelSection>
    )

    const section = screen.getByRole("region", { name: "Listener" })
    expect(section).toHaveTextContent("Bind-time settings")
    expect(section).toHaveTextContent("Restart")
    expect(section).toHaveTextContent("Fields")
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "Listener icon" })).toBeInTheDocument()
  })

  it("exposes each stacked section as an independently named region", () => {
    render(
      <GatewayPanelStack>
        <GatewayPanelSection title="One">First</GatewayPanelSection>
        <GatewayPanelSection title="Two">Second</GatewayPanelSection>
      </GatewayPanelStack>
    )

    expect(screen.getByRole("region", { name: "One" })).toHaveTextContent("First")
    expect(screen.getByRole("region", { name: "Two" })).toHaveTextContent("Second")
  })
})

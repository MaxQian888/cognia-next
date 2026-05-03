/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { PluginPanelProvider, usePluginPanel } from "./plugin-panel-context"

function Probe() {
  const ctx = usePluginPanel()
  return (
    <div>
      <span data-testid="className">{ctx.className ?? "(none)"}</span>
      <span data-testid="embedded">{String(ctx.embedded ?? false)}</span>
    </div>
  )
}

describe("PluginPanelContext", () => {
  it("returns empty defaults outside of a provider", () => {
    render(<Probe />)
    expect(screen.getByTestId("className")).toHaveTextContent("(none)")
    expect(screen.getByTestId("embedded")).toHaveTextContent("false")
  })

  it("hands back the provided value inside a provider", () => {
    render(
      <PluginPanelProvider value={{ className: "my-class", embedded: true }}>
        <Probe />
      </PluginPanelProvider>
    )
    expect(screen.getByTestId("className")).toHaveTextContent("my-class")
    expect(screen.getByTestId("embedded")).toHaveTextContent("true")
  })
})

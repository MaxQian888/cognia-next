/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { A2UIAgentCatalogProvider, useA2UIAgentCatalogId } from "./a2ui-agent-catalog"

function Probe() {
  return <span data-testid="catalog">{useA2UIAgentCatalogId() ?? "none"}</span>
}

describe("A2UIAgentCatalogProvider", () => {
  it("is undefined outside a provider", () => {
    render(<Probe />)
    expect(screen.getByTestId("catalog")).toHaveTextContent("none")
  })

  it("exposes the nearest agent's catalog", () => {
    render(
      <A2UIAgentCatalogProvider catalogId="outer">
        <A2UIAgentCatalogProvider catalogId="financial">
          <Probe />
        </A2UIAgentCatalogProvider>
      </A2UIAgentCatalogProvider>
    )
    expect(screen.getByTestId("catalog")).toHaveTextContent("financial")
  })
})

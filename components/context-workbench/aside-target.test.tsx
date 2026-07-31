/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { AsideTargetProvider, useAsideTarget } from "./aside-target"

function Probe() {
  const target = useAsideTarget()
  return <span data-testid="target">{target ?? "none"}</span>
}

describe("useAsideTarget", () => {
  it("is null outside a sidechat", () => {
    // Every other workbench chat is bound to a document, where "hand back to
    // the main thread" has no meaning — the action must stay hidden there.
    render(<Probe />)
    expect(screen.getByTestId("target")).toHaveTextContent("none")
  })

  it("exposes the main conversation inside a sidechat", () => {
    render(
      <AsideTargetProvider sessionId="main-1">
        <Probe />
      </AsideTargetProvider>
    )
    expect(screen.getByTestId("target")).toHaveTextContent("main-1")
  })

  it("lets a nested provider win, so panes never cross-target", () => {
    render(
      <AsideTargetProvider sessionId="outer">
        <AsideTargetProvider sessionId="inner">
          <Probe />
        </AsideTargetProvider>
      </AsideTargetProvider>
    )
    expect(screen.getByTestId("target")).toHaveTextContent("inner")
  })
})

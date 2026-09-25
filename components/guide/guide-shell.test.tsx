/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

import { GuideShell } from "./guide-shell"

const renderShell = (props: Partial<Parameters<typeof GuideShell>[0]> = {}) =>
  render(
    <GuideShell
      testIdPrefix="flow"
      bodyKey="one"
      windowBar={<header data-testid="bar" />}
      panel={<aside data-testid="panel" />}
      {...props}
    >
      <p>body</p>
    </GuideShell>
  )

describe("GuideShell", () => {
  it("owns the viewport with an opaque surface and a definite height", () => {
    renderShell()
    const shell = screen.getByTestId("flow-shell")
    expect(shell).toHaveClass("h-[100dvh]", "overflow-hidden", "bg-background", "flex-1", "min-h-0")
  })

  it("enters once as a whole, and keeps every edge square", () => {
    renderShell({ footer: <button>next</button> })
    const shell = screen.getByTestId("flow-shell")
    expect(shell).toHaveClass("animate-in", "fade-in")
    expect(shell.className).not.toMatch(/\brounded-/)
    expect(screen.getByTestId("flow-actions").className).not.toMatch(/\brounded-/)
  })

  it("renders the bar, the panel and the body in one frame", () => {
    renderShell()
    expect(screen.getByTestId("bar")).toBeInTheDocument()
    expect(screen.getByTestId("panel")).toBeInTheDocument()
    expect(screen.getByTestId("flow-step-body")).toHaveTextContent("body")
  })

  it("replays only the body's entrance on a step change", () => {
    const { rerender } = renderShell()
    const shell = screen.getByTestId("flow-shell")
    const firstBody = screen.getByTestId("flow-step-body")
    expect(firstBody).toHaveClass("animate-in", "slide-in-from-bottom-2")

    rerender(
      <GuideShell
        testIdPrefix="flow"
        bodyKey="two"
        windowBar={<header data-testid="bar" />}
        panel={<aside data-testid="panel" />}
      >
        <p>next body</p>
      </GuideShell>
    )
    expect(screen.getByTestId("flow-shell")).toBe(shell)
    expect(screen.getByTestId("flow-step-body")).not.toBe(firstBody)
  })

  it("gives every flow the same body width", () => {
    renderShell()
    expect(screen.getByTestId("flow-step-body")).toHaveClass("max-w-[38rem]")
  })

  it("omits the footer region when there are no actions", () => {
    const { container } = renderShell()
    expect(container.querySelector("footer")).toBeNull()
  })

  it("scrolls as one page below `md` in the page-scrolling layout", () => {
    renderShell({ overflow: "scroll" })
    const row = screen.getByTestId("panel").parentElement!
    expect(row).toHaveClass("overflow-y-auto", "md:overflow-hidden")
  })

  it("forwards the flow's own data hooks", () => {
    renderShell({ dataAttributes: { "data-client": "web" } })
    expect(screen.getByTestId("flow-shell")).toHaveAttribute("data-client", "web")
  })
})

/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import type { SVGProps } from "react"

let reduced = false
jest.mock("motion/react", () => ({
  useReducedMotion: () => reduced,
  motion: {
    linearGradient: (props: SVGProps<SVGLinearGradientElement>) => <linearGradient {...props} />,
  },
}))

import { ConnectionFlow } from "./connection-flow"

const copy = {
  label: "How Cognia connects to external systems",
  centerNode: "Cognia",
}

const nodeLabels = ["Repository", "MCP Server", "Plugin", "Approval Gate"]

describe("ConnectionFlow", () => {
  beforeEach(() => {
    reduced = false
  })

  it("renders the center node label", () => {
    render(<ConnectionFlow copy={copy} nodeLabels={nodeLabels} />)
    expect(screen.getByText("Cognia")).toBeInTheDocument()
  })

  it("renders all source node labels", () => {
    render(<ConnectionFlow copy={copy} nodeLabels={nodeLabels} />)
    expect(screen.getByText("Repository")).toBeInTheDocument()
    expect(screen.getByText("MCP Server")).toBeInTheDocument()
    expect(screen.getByText("Plugin")).toBeInTheDocument()
    expect(screen.getByText("Approval Gate")).toBeInTheDocument()
  })

  it("uses the Magic UI AnimatedBeam primitive for every live connection", () => {
    const { container } = render(
      <ConnectionFlow copy={copy} nodeLabels={nodeLabels} approvalLabel="Approval boundary" />
    )
    expect(container.querySelectorAll('[data-slot="animated-beam"]')).toHaveLength(5)
  })

  it("draws beams only from md up, and a single centred spine below it", () => {
    const { container } = render(
      <ConnectionFlow copy={copy} nodeLabels={nodeLabels} approvalLabel="Approval boundary" />
    )
    for (const beam of container.querySelectorAll('[data-slot="animated-beam"]')) {
      expect(beam).toHaveClass("hidden", "md:block")
    }
    expect(container.querySelector('[data-slot="connection-spine"]')).toHaveClass(
      "left-1/2",
      "md:hidden"
    )
  })

  it("centres the source stack on narrow viewports", () => {
    render(<ConnectionFlow copy={copy} nodeLabels={nodeLabels} />)
    const source = screen.getByRole("button", { name: /Repository/ })
    expect(source.parentElement).toHaveClass("items-center", "md:items-start")
  })

  it("bounds the diagram's width so no path stretches to the shell edge", () => {
    render(<ConnectionFlow copy={copy} nodeLabels={nodeLabels} approvalLabel="Approval" />)
    expect(screen.getByRole("group", { name: copy.label })).toHaveClass("max-w-5xl")
  })

  it("has an accessible label on the interactive flow", () => {
    render(<ConnectionFlow copy={copy} nodeLabels={nodeLabels} />)
    expect(
      screen.getByRole("group", { name: "How Cognia connects to external systems" })
    ).toBeInTheDocument()
  })

  it("reports the focused source so related receipt data can be highlighted", () => {
    const onActiveIndexChange = jest.fn()
    render(
      <ConnectionFlow
        copy={copy}
        nodeLabels={nodeLabels}
        approvalLabel="Approval boundary"
        onActiveIndexChange={onActiveIndexChange}
      />
    )

    fireEvent.focus(screen.getByRole("button", { name: "MCP Server" }))
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(1)
  })

  describe("reduced motion", () => {
    beforeEach(() => {
      reduced = true
    })

    it("renders static SVG connectors instead of animated beams", () => {
      const { container } = render(<ConnectionFlow copy={copy} nodeLabels={nodeLabels} />)
      // Static lines present
      const lines = container.querySelectorAll("line")
      expect(lines.length).toBe(4)
    })
  })
})

/** @jest-environment jsdom */

// The profile's section frame and its two small row primitives (ADR-0220).

import { render, screen } from "@testing-library/react"

import { AgentFactRow, AgentSection, AgentSectionEmpty } from "./agent-section"

describe("AgentSection", () => {
  it("labels the section by its heading and renders the content", () => {
    render(
      <AgentSection id="work" title="Open work">
        <p>body</p>
      </AgentSection>
    )
    const section = screen.getByTestId("agent-section-work")
    expect(section).toHaveAttribute("aria-labelledby", "agent-section-work-heading")
    expect(screen.getByRole("heading", { name: "Open work" })).toHaveAttribute(
      "id",
      "agent-section-work-heading"
    )
    expect(screen.getByRole("region", { name: "Open work" })).toBe(section)
    expect(section).toHaveTextContent("body")
  })

  it("shows the meta and the action only when given", () => {
    const { rerender } = render(
      <AgentSection id="a" title="T">
        x
      </AgentSection>
    )
    expect(screen.queryByText("3 open")).not.toBeInTheDocument()
    rerender(
      <AgentSection id="a" title="T" meta="3 open" action={<button type="button">Act</button>}>
        x
      </AgentSection>
    )
    expect(screen.getByText("3 open")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Act" })).toBeInTheDocument()
  })

  it("merges a caller class onto the section", () => {
    render(
      <AgentSection id="a" title="T" className="extra-class">
        x
      </AgentSection>
    )
    expect(screen.getByTestId("agent-section-a")).toHaveClass("extra-class")
  })
})

describe("AgentFactRow", () => {
  it("pairs a term with its value", () => {
    render(
      <dl>
        <AgentFactRow label="Model">gpt-x</AgentFactRow>
      </dl>
    )
    expect(screen.getByRole("term")).toHaveTextContent("Model")
    expect(screen.getByRole("definition")).toHaveTextContent("gpt-x")
  })

  it("truncates by default, wraps on request, and sets mono values in a monospace face", () => {
    const { rerender } = render(
      <dl>
        <AgentFactRow label="L">v</AgentFactRow>
      </dl>
    )
    expect(screen.getByRole("definition")).toHaveClass("truncate")
    expect(screen.getByRole("definition")).not.toHaveClass("font-mono")
    rerender(
      <dl>
        <AgentFactRow label="L" wrap mono>
          v
        </AgentFactRow>
      </dl>
    )
    expect(screen.getByRole("definition")).toHaveClass("break-words")
    expect(screen.getByRole("definition")).not.toHaveClass("truncate")
    expect(screen.getByRole("definition")).toHaveClass("font-mono")
  })
})

describe("AgentSectionEmpty", () => {
  it("renders a muted one-liner", () => {
    render(<AgentSectionEmpty>Nothing here</AgentSectionEmpty>)
    expect(screen.getByText("Nothing here")).toHaveClass("text-muted-foreground")
  })
})

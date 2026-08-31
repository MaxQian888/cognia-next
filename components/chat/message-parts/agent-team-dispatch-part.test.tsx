/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { AgentTeamDispatchPart } from "./agent-team-dispatch-part"
import type { AgentTeamDispatchPart as DispatchType } from "@/lib/claude/parts-extensions"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const base: DispatchType = {
  type: "agent-team-dispatch",
  from: "supervisor-id",
  to: "alice-id",
  toName: "Alice",
  task: "Investigate the schema and return a one-paragraph summary.",
  sessionId: "s1",
}

describe("AgentTeamDispatchPart", () => {
  it("renders the from→to header with the target's display name", () => {
    render(<AgentTeamDispatchPart part={base} fromName="Captain" />)
    expect(screen.getByText("Captain")).toBeInTheDocument()
    expect(screen.getByTestId("dispatch-to").textContent).toBe("Alice")
  })

  it("falls back to a generic supervisor label when fromName is missing", () => {
    render(<AgentTeamDispatchPart part={base} />)
    expect(screen.getByText("supervisor")).toBeInTheDocument()
  })

  it("renders the task body verbatim", () => {
    render(<AgentTeamDispatchPart part={base} />)
    expect(screen.getByText(/Investigate the schema/)).toBeInTheDocument()
  })

  it("marks decorative icons aria-hidden (no SR noise)", () => {
    const { container } = render(<AgentTeamDispatchPart part={base} fromName="Captain" />)
    const icons = container.querySelectorAll("svg")
    expect(icons.length).toBeGreaterThan(0)
    icons.forEach((svg) => expect(svg).toHaveAttribute("aria-hidden"))
  })

  it("renders an Open-member link pointing at the character in Discover", () => {
    render(<AgentTeamDispatchPart part={base} />)
    const link = screen.getByTestId("dispatch-open") as HTMLAnchorElement
    expect(link.getAttribute("href")).toBe("/discover?category=characters&item=alice-id")
  })

  it("preserves whitespace in the task (whitespace-pre-wrap)", () => {
    const part = { ...base, task: "line1\n\nline2" }
    render(<AgentTeamDispatchPart part={part} />)
    const body = screen.getByText(/line1/)
    expect(body.className).toMatch(/whitespace-pre-wrap/)
  })

  it("tags the card with the active display mode", () => {
    render(<AgentTeamDispatchPart part={base} mode="detailed" />)
    expect(screen.getByTestId("agent-team-dispatch-alice-id").dataset.mode).toBe("detailed")
  })

  describe("simplified mode", () => {
    it("drops the task body but keeps the from→to header and open link", () => {
      render(<AgentTeamDispatchPart part={base} fromName="Captain" mode="simplified" />)
      expect(screen.getByText("Captain")).toBeInTheDocument()
      expect(screen.getByTestId("dispatch-to").textContent).toBe("Alice")
      expect(screen.queryByText(/Investigate the schema/)).toBeNull()
      const link = screen.getByTestId("dispatch-open") as HTMLAnchorElement
      expect(link.getAttribute("href")).toBe("/discover?category=characters&item=alice-id")
    })
  })
})

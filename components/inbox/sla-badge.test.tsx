/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { SlaBadge } from "./sla-badge"

const HOUR = 60 * 60 * 1000

describe("SlaBadge", () => {
  it("renders nothing when no SLA deadline is set", () => {
    const { container } = render(<SlaBadge status="open" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing once the conversation is resolved", () => {
    const { container } = render(
      <SlaBadge status="resolved" nextResponseDueAt={Date.now() - HOUR} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("shows a countdown when the deadline is in the future", () => {
    render(<SlaBadge status="open" nextResponseDueAt={Date.now() + 2 * HOUR} />)
    const badge = screen.getByTestId("sla-badge")
    expect(badge).toHaveTextContent(/Due in/i)
    expect(badge).toHaveTextContent(/2h/)
  })

  it("shows OVERDUE when the deadline has passed and the conversation is open", () => {
    render(<SlaBadge status="open" nextResponseDueAt={Date.now() - HOUR} />)
    expect(screen.getByTestId("sla-badge")).toHaveTextContent(/Overdue/i)
  })

  it("suffixes the escalation level when the chain has fired (slice 1B)", () => {
    render(<SlaBadge status="open" nextResponseDueAt={Date.now() - HOUR} escalatedStep={1} />)
    const badge = screen.getByTestId("sla-badge")
    expect(badge).toHaveTextContent(/Overdue/i)
    expect(screen.getByTestId("sla-badge-escalation")).toHaveTextContent("· L2")
    expect(badge.getAttribute("aria-label")).toMatch(/escalation level 2/)
  })

  it("omits the escalation suffix when no step has fired or the value is invalid", () => {
    const { rerender } = render(<SlaBadge status="open" nextResponseDueAt={Date.now() + HOUR} />)
    expect(screen.queryByTestId("sla-badge-escalation")).not.toBeInTheDocument()
    rerender(<SlaBadge status="open" nextResponseDueAt={Date.now() + HOUR} escalatedStep={-1} />)
    expect(screen.queryByTestId("sla-badge-escalation")).not.toBeInTheDocument()
    rerender(<SlaBadge status="open" nextResponseDueAt={Date.now() + HOUR} escalatedStep={0} />)
    expect(screen.getByTestId("sla-badge-escalation")).toHaveTextContent("· L1")
  })

  it("humanizes a sub-minute deadline in seconds", () => {
    render(<SlaBadge status="open" nextResponseDueAt={Date.now() + 10_000} />)
    expect(screen.getByTestId("sla-badge")).toHaveTextContent(/\d+s/)
  })

  it("humanizes a multi-day deadline in days", () => {
    render(<SlaBadge status="open" nextResponseDueAt={Date.now() + 3 * 24 * HOUR} />)
    expect(screen.getByTestId("sla-badge")).toHaveTextContent(/3d/)
  })
})

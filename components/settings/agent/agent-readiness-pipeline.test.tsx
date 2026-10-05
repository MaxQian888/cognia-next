/**
 * AgentReadinessPipeline / AgentReadinessDots / AgentStatePill —
 * pure render tests over fabricated readiness states.
 */

import { render, screen } from "@testing-library/react"
import {
  AgentReadinessDots,
  AgentReadinessPipeline,
  AgentStatePill,
} from "./agent-readiness-pipeline"
import type { AgentReadiness } from "@/lib/ai/agent/external/agent-readiness"

const fullyReady: AgentReadiness = {
  state: "connected",
  blockReason: null,
  blockTransient: false,
  steps: [
    { id: "configured", state: "done" },
    { id: "runnable", state: "done" },
    { id: "connected", state: "done" },
    { id: "routed", state: "done" },
  ],
  nextAction: null,
}

const blocked: AgentReadiness = {
  state: "blocked",
  blockReason: "runtime not installed",
  blockTransient: false,
  steps: [
    { id: "configured", state: "done" },
    { id: "runnable", state: "failed" },
    { id: "connected", state: "todo" },
    { id: "routed", state: "todo" },
  ],
  nextAction: "inspect",
}

describe("AgentReadinessPipeline", () => {
  it("renders every step with its state encoded in the testid", () => {
    render(<AgentReadinessPipeline readiness={blocked} />)
    expect(screen.getByTestId("step-configured-done")).toBeInTheDocument()
    expect(screen.getByTestId("step-runnable-failed")).toBeInTheDocument()
    expect(screen.getByTestId("step-connected-todo")).toBeInTheDocument()
    expect(screen.getByTestId("step-routed-todo")).toBeInTheDocument()
    // Full density carries the step labels.
    expect(screen.getByText("Runnable")).toBeInTheDocument()
  })

  it("compact mode drops visible labels but keeps the step markers", () => {
    render(<AgentReadinessPipeline readiness={fullyReady} compact />)
    expect(screen.getAllByTestId(/^step-.*-done$/)).toHaveLength(4)
    // Every visible label is gone; what remains is screen-reader-only text.
    for (const node of screen.getAllByText(/^Connected:/)) {
      expect(node).toHaveClass("sr-only")
    }
  })

  it("compact mode still names each step and its state to a screen reader", () => {
    render(<AgentReadinessPipeline readiness={blocked} compact />)
    const items = screen.getAllByRole("listitem").map((item) => item.textContent)
    expect(items).toHaveLength(4)
    expect(items[1]).toContain("Runnable")
    expect(items.every((text) => Boolean(text?.trim()))).toBe(true)
  })
})

describe("AgentReadinessDots", () => {
  it("renders one dot per step with an accessible summary", () => {
    render(<AgentReadinessDots readiness={blocked} />)
    expect(screen.getByTestId("dot-runnable-failed")).toBeInTheDocument()
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Runnable")
  })
})

describe("AgentStatePill", () => {
  it("labels each state from the i18n map", () => {
    render(<AgentStatePill readiness={fullyReady} />)
    expect(screen.getByTestId("agent-state-connected")).toHaveTextContent("Connected")
  })

  it("renders a transient block as checking, not settled failure", () => {
    render(<AgentStatePill readiness={{ ...blocked, blockTransient: true }} />)
    expect(screen.getByTestId("agent-state-blocked")).toHaveTextContent("Checking")
  })
})

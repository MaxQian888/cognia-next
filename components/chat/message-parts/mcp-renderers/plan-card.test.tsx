/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"
import { PlanCard } from "./plan-card"

// The card delegates plan body rendering to the shared MarkdownRenderer; stub
// it so this test stays focused on the card's own parsing / gating.
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}))

const part = (input?: unknown): ToolUIPart =>
  ({
    type: "tool-ExitPlanMode",
    toolCallId: "call",
    state: "output-available",
    input,
  }) as unknown as ToolUIPart

describe("PlanCard", () => {
  it("renders the plan markdown body inside a capped scroll container", () => {
    const { container } = render(<PlanCard part={part({ plan: "## Plan\n\n- step one" })} />)
    expect(screen.getByTestId("mcp-plan-card")).toBeInTheDocument()
    expect(screen.getByTestId("md")).toHaveTextContent("step one")
    // A long plan must scroll inside its own container rather than expand the
    // whole transcript (the fix for the "can't scroll the plan" report). Native
    // overflow — not a hover-only Radix ScrollArea — so the thumb stays
    // grabbable while text is selected.
    const scroller = container.querySelector(".max-h-80")
    expect(scroller).toBeTruthy()
    expect(scroller?.className).toContain("overflow-y-auto")
  })

  it("trims whitespace-only plans and renders nothing", () => {
    const { container } = render(<PlanCard part={part({ plan: "   \n  " })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing when input.plan is missing or non-string", () => {
    expect(render(<PlanCard part={part({})} />).container).toBeEmptyDOMElement()
    expect(render(<PlanCard part={part({ plan: 42 })} />).container).toBeEmptyDOMElement()
    expect(render(<PlanCard part={part(undefined)} />).container).toBeEmptyDOMElement()
  })
})

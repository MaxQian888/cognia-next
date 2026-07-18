/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ExternalAgentPlan } from "./plan"
import type { AcpPlanEntry } from "@/types/agent/external-agent"

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const wrap = (ui: React.ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
    <TooltipProvider>{ui}</TooltipProvider>
  </NextIntlClientProvider>
)

function makeEntry(overrides: Partial<AcpPlanEntry> = {}): AcpPlanEntry {
  return {
    content: "Default step",
    priority: "medium",
    status: "pending",
    ...overrides,
  }
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("ExternalAgentPlan", () => {
  it("renders null when entries is empty", () => {
    const { container } = render(wrap(<ExternalAgentPlan entries={[]} />))
    expect(container).toBeEmptyDOMElement()
  })

  it("renders an identified file plan without item entries", () => {
    render(
      wrap(
        <ExternalAgentPlan
          entries={[]}
          document={{ planId: "file", kind: "file", uri: "file:///work/PLAN.md" }}
        />
      )
    )
    expect(screen.getByText("file:///work/PLAN.md")).toBeInTheDocument()
  })

  it("renders identified Markdown plan content", () => {
    render(
      wrap(
        <ExternalAgentPlan
          entries={[]}
          document={{ planId: "markdown", kind: "markdown", content: "# Ship it" }}
        />
      )
    )
    expect(screen.getByText("# Ship it")).toBeInTheDocument()
  })

  it("renders null when entries is undefined-like (null guard)", () => {
    // The component guards `!entries || entries.length === 0`
    const { container } = render(wrap(<ExternalAgentPlan entries={[] as AcpPlanEntry[]} />))
    expect(container).toBeEmptyDOMElement()
  })

  it("renders the execution plan heading", () => {
    render(wrap(<ExternalAgentPlan entries={[makeEntry({ content: "Step one" })]} />))
    expect(screen.getByText(en.externalAgent.executionPlan)).toBeInTheDocument()
  })

  it("renders the steps-completed counter", () => {
    const entries: AcpPlanEntry[] = [
      makeEntry({ status: "completed", content: "Done step" }),
      makeEntry({ status: "pending", content: "Pending step" }),
    ]
    render(wrap(<ExternalAgentPlan entries={entries} />))
    // The span renders as "1/2 completed" (or equivalent i18n word)
    expect(screen.getByText(/1\/2/)).toBeInTheDocument()
    // The i18n value for stepsCompleted is "completed" — the counter span
    // contains both the fraction and the word, so we match via regex.
    expect(screen.getByText(new RegExp(en.externalAgent.stepsCompleted))).toBeInTheDocument()
  })

  it("renders plan entry content text", () => {
    render(wrap(<ExternalAgentPlan entries={[makeEntry({ content: "Write the tests" })]} />))
    expect(screen.getByText("Write the tests")).toBeInTheDocument()
  })

  it("renders step numbers", () => {
    const entries = [makeEntry({ content: "Step A" }), makeEntry({ content: "Step B" })]
    render(wrap(<ExternalAgentPlan entries={entries} />))
    expect(screen.getByText("1")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
  })

  it("shows priority badges in normal mode", () => {
    render(
      wrap(
        <ExternalAgentPlan
          entries={[
            makeEntry({ priority: "high", content: "High priority" }),
            makeEntry({ priority: "medium", content: "Medium priority" }),
            makeEntry({ priority: "low", content: "Low priority" }),
          ]}
        />
      )
    )
    expect(screen.getByText("high")).toBeInTheDocument()
    expect(screen.getByText("medium")).toBeInTheDocument()
    expect(screen.getByText("low")).toBeInTheDocument()
  })

  it("hides priority badges in compact mode", () => {
    render(
      wrap(
        <ExternalAgentPlan
          entries={[makeEntry({ priority: "high", content: "Step compact" })]}
          compact
        />
      )
    )
    expect(screen.queryByText("high")).not.toBeInTheDocument()
  })

  it("applies active background styling to the currentStep entry", () => {
    const entries = [makeEntry({ content: "First" }), makeEntry({ content: "Second" })]
    render(wrap(<ExternalAgentPlan entries={entries} currentStep={1} />))
    // "Second" is the active step — its wrapper div carries bg-accent
    const secondText = screen.getByText("Second")
    const wrapper = secondText.closest(".rounded-md")
    expect(wrapper).toHaveClass("bg-accent")
  })

  it("does NOT apply active styling when currentStep is null", () => {
    render(wrap(<ExternalAgentPlan entries={[makeEntry({ content: "Solo" })]} />))
    const text = screen.getByText("Solo")
    const wrapper = text.closest(".rounded-md")
    expect(wrapper).not.toHaveClass("bg-accent")
  })

  it("renders completed entries with reduced opacity and line-through", () => {
    render(
      wrap(<ExternalAgentPlan entries={[makeEntry({ status: "completed", content: "Done it" })]} />)
    )
    const wrapper = screen.getByText("Done it").closest(".rounded-md")
    expect(wrapper).toHaveClass("opacity-60")
    expect(screen.getByText("Done it")).toHaveClass("line-through")
  })

  it("renders skipped entries with lower opacity", () => {
    render(
      wrap(
        <ExternalAgentPlan entries={[makeEntry({ status: "skipped", content: "Skipped step" })]} />
      )
    )
    const wrapper = screen.getByText("Skipped step").closest(".rounded-md")
    expect(wrapper).toHaveClass("opacity-40")
  })

  it("renders in_progress entries without opacity reduction", () => {
    render(
      wrap(
        <ExternalAgentPlan entries={[makeEntry({ status: "in_progress", content: "Working" })]} />
      )
    )
    const wrapper = screen.getByText("Working").closest(".rounded-md")
    expect(wrapper).not.toHaveClass("opacity-60")
    expect(wrapper).not.toHaveClass("opacity-40")
  })

  it("shows 0 completed when all entries are pending", () => {
    const entries = [
      makeEntry({ status: "pending", content: "P1" }),
      makeEntry({ status: "pending", content: "P2" }),
    ]
    render(wrap(<ExternalAgentPlan entries={entries} />))
    expect(screen.getByText(/0\/2/)).toBeInTheDocument()
  })

  it("shows all completed when all entries are done", () => {
    const entries = [
      makeEntry({ status: "completed", content: "C1" }),
      makeEntry({ status: "completed", content: "C2" }),
    ]
    render(wrap(<ExternalAgentPlan entries={entries} />))
    expect(screen.getByText(/2\/2/)).toBeInTheDocument()
  })

  it("applies custom className to the outer wrapper", () => {
    const { container } = render(
      wrap(<ExternalAgentPlan entries={[makeEntry()]} className="my-test-class" />)
    )
    expect(container.firstChild).toHaveClass("my-test-class")
  })

  it("truncates step text in compact mode", () => {
    render(wrap(<ExternalAgentPlan entries={[makeEntry({ content: "Long step text" })]} compact />))
    const text = screen.getByText("Long step text")
    expect(text).toHaveClass("truncate")
  })

  it("does not truncate text in normal mode", () => {
    render(wrap(<ExternalAgentPlan entries={[makeEntry({ content: "Long step text" })]} />))
    const text = screen.getByText("Long step text")
    expect(text).not.toHaveClass("truncate")
  })
})

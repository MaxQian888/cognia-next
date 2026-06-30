/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { AssessmentCard } from "./assessment-card"
import type { Assessment } from "@/lib/analysis/session-report"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

function make(over: Partial<Assessment> = {}): Assessment {
  return {
    id: "context",
    score: 0.9,
    level: "critical",
    reasoningKey: "context.critical",
    params: { pct: 90 },
    ...over,
  }
}

describe("AssessmentCard", () => {
  it("renders the label, level, score bar, and reasoning", () => {
    render(<AssessmentCard assessment={make()} />)
    expect(screen.getByTestId("assessment-context")).toBeInTheDocument()
    expect(screen.getByTestId("assessment-level")).toHaveTextContent("assessments.level.critical")
    expect(screen.getByText(/assessments.label.context/)).toBeInTheDocument()
    expect(screen.getByText(/assessments.reasoning.context.critical/)).toHaveTextContent('"pct":90')
  })

  it("maps the score to the progressbar value", () => {
    render(<AssessmentCard assessment={make({ score: 0.42 })} />)
    expect(screen.getByTestId("assessment-score")).toHaveAttribute("aria-valuenow", "42")
  })

  it("applies the level color class", () => {
    render(<AssessmentCard assessment={make({ level: "healthy" })} />)
    expect(screen.getByTestId("assessment-level")).toHaveClass("text-emerald-500")
  })
})

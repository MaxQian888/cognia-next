/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen } from "@testing-library/react"
import { SkillAuditBadges } from "./skill-audit-badges"
import type { SkillsShAudit } from "@/lib/skills/marketplace-skillssh"

const AUDIT: SkillsShAudit = {
  providers: [
    { provider: "Socket", risk: "safe", score: 90 },
    { provider: "Snyk", risk: "medium" },
    { provider: "ZeroLeaks", risk: "high", summary: "leaks" },
  ],
  worstRisk: "high",
}

describe("SkillAuditBadges — full mode", () => {
  it("renders one badge per provider with risk label and score", () => {
    render(<SkillAuditBadges audit={AUDIT} />)
    expect(screen.getByTestId("skill-audit-badges")).toBeInTheDocument()
    expect(screen.getByText(/Socket · risk\.safe \(90\)/)).toBeInTheDocument()
    expect(screen.getByText(/Snyk · risk\.medium/)).toBeInTheDocument()
    expect(screen.getByText(/ZeroLeaks · risk\.high/)).toBeInTheDocument()
  })

  it("shows the loading state for 'loading' and undefined", () => {
    const { rerender } = render(<SkillAuditBadges audit="loading" />)
    expect(screen.getByText("loading")).toBeInTheDocument()
    rerender(<SkillAuditBadges audit={undefined} />)
    expect(screen.getByText("loading")).toBeInTheDocument()
  })

  it("shows the no-data state for null", () => {
    render(<SkillAuditBadges audit={null} />)
    expect(screen.getByText("noData")).toBeInTheDocument()
  })
})

describe("SkillAuditBadges — compact mode", () => {
  it("renders a worst-risk dot with an accessible label", () => {
    render(<SkillAuditBadges audit={AUDIT} compact />)
    const dot = screen.getByTestId("skill-audit-dot")
    expect(dot).toHaveAttribute("aria-label", "risk.high")
  })

  it("renders nothing while unresolved or absent", () => {
    const { container, rerender } = render(<SkillAuditBadges audit={undefined} compact />)
    expect(container).toBeEmptyDOMElement()
    rerender(<SkillAuditBadges audit="loading" compact />)
    expect(container).toBeEmptyDOMElement()
    rerender(<SkillAuditBadges audit={null} compact />)
    expect(container).toBeEmptyDOMElement()
  })
})

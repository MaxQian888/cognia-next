/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useLocale: () => "en" }))

import { FindingCard } from "./finding-card"
import type { StrixFinding } from "../types"

const base: StrixFinding = {
  runId: "r",
  vulnId: "v1",
  title: "SQL Injection",
  severity: "critical",
}

describe("FindingCard", () => {
  it("renders the title and a severity badge", () => {
    render(<FindingCard finding={base} />)
    expect(screen.getByText("SQL Injection")).toBeInTheDocument()
    const el = screen.getByTestId("strix-finding")
    expect(el).toHaveAttribute("data-severity", "critical")
    expect(screen.getByText("critical")).toBeInTheDocument()
  })

  it("renders optional sections only when present", () => {
    render(
      <FindingCard
        finding={{
          ...base,
          impact: "RCE",
          remediationSteps: "Parameterize queries",
          pocScriptCode: "curl x",
        }}
      />
    )
    expect(screen.getByText("RCE")).toBeInTheDocument()
    expect(screen.getByText("Parameterize queries")).toBeInTheDocument()
    expect(screen.getByText("curl x")).toBeInTheDocument()
  })

  it("shows metadata chips (cvss / cwe / endpoint)", () => {
    render(
      <FindingCard
        finding={{ ...base, cvss: 9.1, cwe: "CWE-89", endpoint: "/login", method: "POST" }}
      />
    )
    expect(screen.getByText("CWE-89")).toBeInTheDocument()
    expect(screen.getByText(/POST/)).toBeInTheDocument()
  })
})

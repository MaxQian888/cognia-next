/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

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

  it("renders code locations with file:line and snippet", () => {
    render(
      <FindingCard
        finding={{
          ...base,
          codeLocations: [
            { file: "src/db.ts", startLine: 12, endLine: 18, snippet: "query(user)" },
            { label: "entrypoint" },
          ],
        }}
      />
    )
    expect(screen.getByTestId("strix-finding-locations")).toBeInTheDocument()
    expect(screen.getByText("src/db.ts:12–18")).toBeInTheDocument()
    expect(screen.getByText("query(user)")).toBeInTheDocument()
    expect(screen.getByText("Unknown location")).toBeInTheDocument()
    expect(screen.getByText("entrypoint")).toBeInTheDocument()
  })

  it("omits the locations section when the report has none", () => {
    render(<FindingCard finding={base} />)
    expect(screen.queryByTestId("strix-finding-locations")).not.toBeInTheDocument()
  })

  describe("triage", () => {
    const triageable: StrixFinding = { ...base, fingerprint: "fp1", ruleId: "sqli" }

    it("offers no triage control for a finding with no stable identity", () => {
      // A row written before fingerprinting cannot carry a verdict across a
      // rescan, so the control is hidden rather than offered and silently lost.
      render(<FindingCard finding={base} onStateChange={jest.fn()} />)
      expect(screen.queryByTestId("strix-finding-state")).not.toBeInTheDocument()
    })

    it("offers no triage control when no handler was supplied", () => {
      render(<FindingCard finding={triageable} />)
      expect(screen.queryByTestId("strix-finding-state")).not.toBeInTheDocument()
    })

    it("reports the current verdict and emits a change", async () => {
      const onStateChange = jest.fn()
      const user = userEvent.setup()
      render(<FindingCard finding={triageable} state="open" onStateChange={onStateChange} />)
      const trigger = screen.getByTestId("strix-finding-state")
      expect(trigger).toHaveTextContent("Open")

      await user.click(trigger)
      await user.click(screen.getByRole("option", { name: "False positive" }))
      expect(onStateChange).toHaveBeenCalledWith("false-positive")
    })

    it("offers every verdict in the closed set", async () => {
      const user = userEvent.setup()
      render(<FindingCard finding={triageable} onStateChange={jest.fn()} />)
      await user.click(screen.getByTestId("strix-finding-state"))
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
        "Open",
        "Risk accepted",
        "False positive",
        "Fixed",
      ])
    })

    it("shows the recorded verdict as a badge when it is not open", () => {
      render(<FindingCard finding={triageable} state="fixed" onStateChange={jest.fn()} />)
      expect(screen.getByTestId("strix-finding-state-badge")).toHaveTextContent("Fixed")
    })

    it("shows no verdict badge while a finding is open", () => {
      render(<FindingCard finding={triageable} state="open" onStateChange={jest.fn()} />)
      expect(screen.queryByTestId("strix-finding-state-badge")).not.toBeInTheDocument()
    })

    it("marks a muted finding without hiding it", () => {
      // Muted means "not worth your attention now", not "gone" — hiding it
      // would make a suppressed critical invisible to the next reader.
      render(<FindingCard finding={triageable} suppressed onStateChange={jest.fn()} />)
      expect(screen.getByTestId("strix-finding")).toHaveAttribute("data-suppressed", "true")
      expect(screen.getByTestId("strix-finding-suppressed")).toBeInTheDocument()
      expect(screen.getByText("SQL Injection")).toBeInTheDocument()
    })

    it("offers to mute the whole rule class, once", async () => {
      const onSuppressRule = jest.fn()
      const user = userEvent.setup()
      const { rerender } = render(
        <FindingCard
          finding={triageable}
          onStateChange={jest.fn()}
          onSuppressRule={onSuppressRule}
        />
      )
      await user.click(screen.getByTestId("strix-suppress-rule"))
      expect(onSuppressRule).toHaveBeenCalled()

      rerender(
        <FindingCard
          finding={triageable}
          ruleMuted
          onStateChange={jest.fn()}
          onSuppressRule={onSuppressRule}
        />
      )
      expect(screen.queryByTestId("strix-suppress-rule")).not.toBeInTheDocument()
      expect(screen.getByTestId("strix-rule-muted")).toBeInTheDocument()
    })

    it("offers to undo a rule mute", async () => {
      // A mute with no undo is a trap: the class vanishes from the gate and
      // nothing on screen can bring it back.
      const onUnsuppressRule = jest.fn()
      const user = userEvent.setup()
      render(
        <FindingCard
          finding={triageable}
          ruleMuted
          onStateChange={jest.fn()}
          onUnsuppressRule={onUnsuppressRule}
        />
      )
      await user.click(screen.getByTestId("strix-rule-muted"))
      expect(onUnsuppressRule).toHaveBeenCalled()
    })

    it("cannot mute a rule for a finding that has no rule class", () => {
      render(
        <FindingCard
          finding={{ ...triageable, ruleId: undefined }}
          onStateChange={jest.fn()}
          onSuppressRule={jest.fn()}
        />
      )
      expect(screen.queryByTestId("strix-suppress-rule")).not.toBeInTheDocument()
    })
  })
})

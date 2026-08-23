/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({ useLocale: () => "en" }))

import { FindingsList } from "./findings-list"
import { I18N_MESSAGES } from "../i18n"
import { FINDING_STATES } from "../types"
import type { FindingStateRow, StrixFinding, SuppressionRule } from "../types"

function finding(over: Partial<StrixFinding> = {}): StrixFinding {
  return {
    runId: "r",
    vulnId: "v1",
    fingerprint: "fp1",
    ruleId: "sqli",
    title: "SQL Injection",
    severity: "critical",
    ...over,
  }
}

function stateRow(fingerprint: string, state: FindingStateRow["state"]): FindingStateRow {
  return { key: `t ${fingerprint}`, target: "t", fingerprint, state, updatedAt: 1 }
}

function rule(ruleId: string): SuppressionRule {
  return { id: `t::${ruleId}`, target: "t", ruleId, createdAt: 1 }
}

describe("FindingsList", () => {
  it("shows a clean state when there is nothing to report", () => {
    render(<FindingsList findings={[]} />)
    expect(screen.getByTestId("strix-findings-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("strix-export-sarif")).not.toBeInTheDocument()
  })

  it("renders one card per finding", () => {
    render(
      <FindingsList
        findings={[finding(), finding({ vulnId: "v2", fingerprint: "fp2", title: "XSS" })]}
      />
    )
    expect(screen.getAllByTestId("strix-finding")).toHaveLength(2)
  })

  it("marks findings muted by a verdict and counts them", () => {
    render(
      <FindingsList
        findings={[finding(), finding({ vulnId: "v2", fingerprint: "fp2" })]}
        states={[stateRow("fp1", "accepted")]}
        onStateChange={jest.fn()}
      />
    )
    const cards = screen.getAllByTestId("strix-finding")
    expect(cards[0]).toHaveAttribute("data-suppressed", "true")
    expect(cards[1]).not.toHaveAttribute("data-suppressed")
    expect(screen.getByTestId("strix-findings-muted")).toHaveTextContent("1")
  })

  it("marks findings muted by a rule covering their class", () => {
    render(
      <FindingsList
        findings={[finding(), finding({ vulnId: "v2", fingerprint: "fp2", ruleId: "xss" })]}
        rules={[rule("sqli")]}
        onStateChange={jest.fn()}
      />
    )
    const cards = screen.getAllByTestId("strix-finding")
    expect(cards[0]).toHaveAttribute("data-suppressed", "true")
    expect(cards[1]).not.toHaveAttribute("data-suppressed")
  })

  it("does not mute a finding marked fixed", () => {
    // Still reported after being called fixed is a contradiction to show.
    render(
      <FindingsList
        findings={[finding()]}
        states={[stateRow("fp1", "fixed")]}
        onStateChange={jest.fn()}
      />
    )
    expect(screen.getByTestId("strix-finding")).not.toHaveAttribute("data-suppressed")
    expect(screen.queryByTestId("strix-findings-muted")).not.toBeInTheDocument()
  })

  it("passes the verdict change up with the finding it belongs to", async () => {
    const onStateChange = jest.fn()
    const user = userEvent.setup()
    const target = finding({ vulnId: "v2", fingerprint: "fp2", title: "XSS" })
    render(<FindingsList findings={[finding(), target]} onStateChange={onStateChange} />)
    await user.selectOptions(screen.getAllByTestId("strix-finding-state")[1], "accepted")
    expect(onStateChange).toHaveBeenCalledWith(target, "accepted")
  })

  it("passes a rule un-mute up with the finding it belongs to", async () => {
    const onUnsuppressRule = jest.fn()
    const user = userEvent.setup()
    const only = finding()
    render(
      <FindingsList
        findings={[only]}
        rules={[rule("sqli")]}
        onStateChange={jest.fn()}
        onUnsuppressRule={onUnsuppressRule}
      />
    )
    await user.click(screen.getByTestId("strix-rule-muted"))
    expect(onUnsuppressRule).toHaveBeenCalledWith(only)
  })

  it("passes a rule mute up with the finding it belongs to", async () => {
    const onSuppressRule = jest.fn()
    const user = userEvent.setup()
    const only = finding()
    render(
      <FindingsList findings={[only]} onStateChange={jest.fn()} onSuppressRule={onSuppressRule} />
    )
    await user.click(screen.getByTestId("strix-suppress-rule"))
    expect(onSuppressRule).toHaveBeenCalledWith(only)
  })

  it("offers a SARIF export only when a handler is supplied", async () => {
    const onExport = jest.fn()
    const user = userEvent.setup()
    const { rerender } = render(<FindingsList findings={[finding()]} />)
    expect(screen.queryByTestId("strix-export-sarif")).not.toBeInTheDocument()

    rerender(<FindingsList findings={[finding()]} onExport={onExport} />)
    await user.click(screen.getByTestId("strix-export-sarif"))
    expect(onExport).toHaveBeenCalled()
  })
})

describe("triage translation keys", () => {
  it("carries every verdict label in both locales", () => {
    // `t(\`triage.state.${value}\`)` is interpolated, so no lint can see it —
    // a missing entry would render the raw identifier `false-positive` to the
    // user. FINDING_STATES is the closed set the select renders from.
    for (const locale of ["en", "zh-CN"] as const) {
      const messages = I18N_MESSAGES[locale] as Record<string, string>
      for (const state of FINDING_STATES) {
        expect([
          locale,
          state,
          typeof messages[`plugin.strix-security.triage.state.${state}`],
        ]).toEqual([locale, state, "string"])
      }
    }
  })

  it("carries the rest of the triage and export labels in both locales", () => {
    const keys = [
      "triage.label",
      "triage.suppressed",
      "triage.muteRule",
      "triage.unmuteRule",
      "triage.mutedCount",
      "export.sarif",
    ]
    for (const locale of ["en", "zh-CN"] as const) {
      const messages = I18N_MESSAGES[locale] as Record<string, string>
      for (const key of keys) {
        expect([locale, key, typeof messages[`plugin.strix-security.${key}`]]).toEqual([
          locale,
          key,
          "string",
        ])
      }
    }
  })
})

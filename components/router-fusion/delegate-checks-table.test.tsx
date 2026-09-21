/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { DelegateChecksTable } from "./delegate-checks-table"
import type { DelegateAcceptanceView } from "./delegate-review-model"

function acceptance(over: Partial<DelegateAcceptanceView> = {}): DelegateAcceptanceView {
  return {
    status: "passed",
    level: "tool_verified",
    revision: "staged:def",
    verifierVersion: "code-acceptance-1",
    tier: "os",
    exit: "0",
    report: "reports/junit.xml",
    discovered: 12,
    passed: 12,
    failed: 0,
    errored: 0,
    skipped: 0,
    checks: [
      {
        checkId: "tests_discovered",
        kind: "tests",
        status: "passed",
        summary: "discovered=12 passed=12 failed=0 skipped=0",
        executedBy: "runtime",
      },
    ],
    hasModelCheck: false,
    ...over,
  }
}

describe("DelegateChecksTable", () => {
  it("shows the attested tier, the verified revision and the counts", () => {
    render(<DelegateChecksTable acceptance={acceptance()} />)
    const table = screen.getByTestId("delegate-checks")
    expect(table).toHaveTextContent("Passed")
    expect(table).toHaveTextContent("OS sandbox")
    expect(table).toHaveTextContent("staged:def")
    expect(screen.getByTestId("delegate-checks-counts")).toHaveTextContent(
      "12 discovered · 12 passed · 0 failed · 0 skipped"
    )
    expect(screen.queryByTestId("delegate-checks-tier-unattested")).not.toBeInTheDocument()
  })

  it("[ACC:SAFE-02] says the sandbox was not attested rather than implying one", () => {
    render(<DelegateChecksTable acceptance={acceptance({ tier: null })} />)
    expect(screen.getByTestId("delegate-checks-tier-unattested")).toHaveTextContent("Not attested")
  })

  it("[ACC:DEL-03] says a report without a revision proves nothing about the change", () => {
    render(<DelegateChecksTable acceptance={acceptance({ revision: null })} />)
    expect(screen.getByTestId("delegate-checks")).toHaveTextContent("The report names no revision")
  })

  it("[ACC:DEL-02] renders a missing count as an em dash, never as zero", () => {
    render(
      <DelegateChecksTable
        acceptance={acceptance({ discovered: null, passed: null, failed: 1, skipped: null })}
      />
    )
    expect(screen.getByTestId("delegate-checks-counts")).toHaveTextContent(
      "— discovered · — passed · 1 failed · — skipped"
    )
  })

  it("[ACC:DEL-01] labels a check a model executed and warns that a claim is not evidence", () => {
    render(
      <DelegateChecksTable
        acceptance={acceptance({
          status: "inconclusive",
          hasModelCheck: true,
          checks: [
            {
              checkId: "worker_claim",
              kind: "claim",
              status: "inconclusive",
              summary: "the worker said the tests pass",
              executedBy: "model",
            },
          ],
        })}
      />
    )
    const table = screen.getByTestId("delegate-checks")
    expect(table).toHaveTextContent("Model")
    expect(table).toHaveTextContent("Only a check the runtime executed is evidence")
  })

  it("says nothing was verified when there is no report at all", () => {
    render(<DelegateChecksTable acceptance={null} />)
    expect(screen.getByTestId("delegate-checks")).toHaveTextContent(
      "This run recorded no acceptance report"
    )
  })

  it("says so when the report carries no counts", () => {
    render(
      <DelegateChecksTable
        acceptance={acceptance({
          discovered: null,
          passed: null,
          failed: null,
          skipped: null,
          errored: null,
        })}
      />
    )
    expect(screen.getByTestId("delegate-checks")).toHaveTextContent(
      "This report records no test counts."
    )
  })
})

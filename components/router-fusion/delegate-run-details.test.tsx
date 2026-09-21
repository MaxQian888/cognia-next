/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { DelegateRunDetails } from "./delegate-run-details"
import type { DelegateProgressView } from "./delegate-review-model"

function progress(over: Partial<DelegateProgressView> = {}): DelegateProgressView {
  return {
    subtasks: 2,
    attempts: 3,
    turns: 6,
    toolOperations: 9,
    repairs: 1,
    takeovers: 1,
    scopeExpansions: 0,
    tier: "container",
    delivery: "patch_only",
    deliveredRevision: "staged:def",
    empty: false,
    ...over,
  }
}

describe("DelegateRunDetails", () => {
  it("[ACC:DEL-06] shows the worker turns, repairs and takeovers the run spent", () => {
    render(<DelegateRunDetails progress={progress()} />)
    const details = screen.getByTestId("delegate-run-details")
    expect(details).toHaveTextContent("Worker turns")
    expect(details).toHaveTextContent("Repairs")
    expect(details).toHaveTextContent("Lead takeovers")
    expect(details).toHaveTextContent("Tool operations")
    expect(details).toHaveTextContent("Container")
    expect(details).toHaveTextContent("Patch only")
  })

  it("[ACC:SAFE-02] says the sandbox was not attested when the run recorded no tier", () => {
    render(<DelegateRunDetails progress={progress({ tier: null })} />)
    expect(screen.getByTestId("delegate-run-details-tier-unattested")).toHaveTextContent(
      "Not attested"
    )
  })

  it("names the paths a person approved beyond the subtask's scope", () => {
    render(<DelegateRunDetails progress={progress({ scopeExpansions: 2 })} />)
    expect(screen.getByTestId("delegate-run-details")).toHaveTextContent("Extra paths you approved")
  })

  it("says the journal recorded no delegate steps rather than showing zeroes", () => {
    render(
      <DelegateRunDetails
        progress={progress({
          empty: true,
          subtasks: null,
          attempts: 0,
          turns: 0,
          toolOperations: 0,
          repairs: 0,
          takeovers: 0,
        })}
      />
    )
    const details = screen.getByTestId("delegate-run-details")
    expect(details).toHaveTextContent("This run recorded no delegate steps.")
    expect(details).not.toHaveTextContent("Worker turns")
  })
})

/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

import { fireEvent, render, screen } from "@testing-library/react"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { IssueTriageRow } from "./issue-triage-row"

const local = { kind: "local" as const, capabilities: FULL_ISSUE_CAPABILITIES }

describe("IssueTriageRow", () => {
  it("explains a pending issue and accepts it through one action", () => {
    const onAction = jest.fn()
    render(<IssueTriageRow item={{ ...local, triage: "pending" }} onAction={onAction} />)
    expect(screen.getByText("triage.pendingHint")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("issue-detail-triage-accept"))
    expect(onAction).toHaveBeenCalledWith({ kind: "triage", to: null })
  })

  it("offers to send an accepted issue back to triage", () => {
    const onAction = jest.fn()
    render(<IssueTriageRow item={local} onAction={onAction} />)
    fireEvent.click(screen.getByTestId("issue-detail-triage-send"))
    expect(onAction).toHaveBeenCalledWith({ kind: "triage", to: "pending" })
  })

  it("stays read-only where edits are refused", () => {
    const { container, rerender } = render(
      <IssueTriageRow item={{ ...local, capabilities: READ_ONLY_ISSUE_CAPABILITIES }} />
    )
    expect(container).toBeEmptyDOMElement()
    rerender(
      <IssueTriageRow
        item={{ ...local, triage: "pending", capabilities: READ_ONLY_ISSUE_CAPABILITIES }}
        onAction={jest.fn()}
      />
    )
    expect(screen.getByTestId("issue-detail-triage")).toBeInTheDocument()
    expect(screen.queryByTestId("issue-detail-triage-accept")).toBeNull()
  })
})

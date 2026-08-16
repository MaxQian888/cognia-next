// ADR-0123 — the notice explains a turn the system accepted but has not
// answered. Each state exists because the right user response differs.

import { render, screen } from "@testing-library/react"

import type { WorkSubmissionStatus } from "@/hooks/work-submission/use-work-submission-status"

import { WorkSubmissionNotice } from "./work-submission-notice"

let status: WorkSubmissionStatus = { state: "idle" }

jest.mock("@/hooks/work-submission/use-work-submission-status", () => ({
  useWorkSubmissionStatus: () => status,
}))

beforeEach(() => {
  status = { state: "idle" }
})

describe("WorkSubmissionNotice", () => {
  it("renders nothing while a turn is streaming normally", () => {
    // The streaming UI already reports this; a second indicator is noise.
    const { container } = render(<WorkSubmissionNotice sessionId="session-1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("explains a queued turn", () => {
    status = { state: "queued" }
    render(<WorkSubmissionNotice sessionId="session-1" />)
    expect(screen.getByTestId("work-submission-queued")).toBeInTheDocument()
  })

  it("distinguishes waiting-to-reconnect from waiting-to-start", () => {
    // Before durable submission these were indistinguishable from a hang.
    status = { state: "blocked" }
    render(<WorkSubmissionNotice sessionId="session-1" />)
    expect(screen.getByTestId("work-submission-blocked")).toBeInTheDocument()
    expect(screen.queryByTestId("work-submission-queued")).not.toBeInTheDocument()
  })

  it("raises a recovery-required turn as destructive, because only a person can clear it", () => {
    status = { state: "recoveryRequired" }
    render(<WorkSubmissionNotice sessionId="session-1" />)
    const alert = screen.getByTestId("work-submission-recovery")
    expect(alert).toBeInTheDocument()
    expect(alert).toHaveAttribute("data-slot", "alert")
  })

  it("renders exactly one notice at a time", () => {
    status = { state: "recoveryRequired" }
    render(<WorkSubmissionNotice sessionId="session-1" />)
    expect(screen.getAllByRole("alert")).toHaveLength(1)
  })

  it("renders nothing when there is no session", () => {
    const { container } = render(<WorkSubmissionNotice sessionId={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })
})

/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { RunRetrospectiveView } from "./run-retrospective-view"

const bundle = {
  retrospective: {
    id: "retro-1",
    runId: "run-1",
    runKey: "run-1:1",
    analysisVersion: 1,
    status: "pending_review" as const,
    issueTimeline: [{ at: 1, summary: "A tool needed review" }],
    contentHash: "hash",
    createdAt: 1,
    updatedAt: 1,
  },
  proposals: [
    {
      id: "proposal-1",
      retrospectiveId: "retro-1",
      runId: "run-1",
      targetKind: "memory-candidate" as const,
      title: "Remember the boundary",
      after: "Use approval before writing",
      status: "pending" as const,
      evidenceRefs: [],
      createdAt: 1,
      updatedAt: 1,
    },
  ],
}

describe("RunRetrospectiveView", () => {
  it("renders shared timeline/proposals and delegates approval", async () => {
    const user = userEvent.setup()
    const onApprove = jest.fn()
    render(<RunRetrospectiveView bundles={[bundle]} onApprove={onApprove} />)

    expect(screen.getByText("A tool needed review")).toBeInTheDocument()
    expect(screen.getByText("Remember the boundary")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Approve and apply" }))
    expect(onApprove).toHaveBeenCalledWith("proposal-1")
  })

  it("shows the shared empty state and manual generation action", async () => {
    const user = userEvent.setup()
    const onGenerate = jest.fn()
    render(<RunRetrospectiveView bundles={[]} canGenerate onGenerate={onGenerate} />)
    expect(screen.getByText("No run review yet")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Generate review" }))
    expect(onGenerate).toHaveBeenCalledTimes(1)
  })
})

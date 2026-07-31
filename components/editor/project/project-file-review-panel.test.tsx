import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProjectFileReviewPanel } from "./project-file-review-panel"
import {
  applyProjectFileProposal,
  proposeProjectFileUpdate,
  registerProjectFileProposalAdapter,
  resetProjectFileProposalsForTesting,
} from "@/lib/context-workbench/project-file-proposals"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

describe("ProjectFileReviewPanel", () => {
  it("accepts and applies a single-file proposal", async () => {
    resetProjectFileProposalsForTesting()
    let content = "before"
    let token = "v1"
    registerProjectFileProposalAdapter("file", {
      capture: () => ({ content, baseToken: token }),
      apply: (next, expected) => {
        if (expected !== token) return false
        content = next
        token = "v2"
        return token
      },
    })
    proposeProjectFileUpdate("file", "after", "request")
    render(<ProjectFileReviewPanel resourceKey="file" />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "accept" }))
    await user.click(screen.getByRole("button", { name: "apply" }))
    expect(content).toBe("after")
    expect(screen.getByRole("button", { name: "undo" })).toBeInTheDocument()
  })

  it("supports reject, discard, stale rebase, and undo", async () => {
    resetProjectFileProposalsForTesting()
    let content = "before"
    let token = "v1"
    registerProjectFileProposalAdapter("file", {
      capture: () => ({ content, baseToken: token }),
      apply: (next, expected) => {
        if (expected !== token) return false
        content = next
        token = `v${Number(token.slice(1)) + 1}`
        return token
      },
    })
    proposeProjectFileUpdate("file", "after", "request")
    const user = userEvent.setup()
    const { rerender } = render(<ProjectFileReviewPanel resourceKey="file" />)

    await user.click(screen.getByRole("button", { name: "reject" }))
    expect(screen.getByRole("button", { name: "apply" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "discard" }))
    expect(screen.getByText("empty")).toBeInTheDocument()

    act(() => proposeProjectFileUpdate("file", "rebased", "request"))
    token = "external"
    await user.click(await screen.findByRole("button", { name: "accept" }))
    act(() => applyProjectFileProposal("file"))
    rerender(<ProjectFileReviewPanel resourceKey="file" />)
    await waitFor(() => expect(screen.getByText("stale")).toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: "rebase" }))
    await user.click(screen.getByRole("button", { name: "accept" }))
    await user.click(screen.getByRole("button", { name: "apply" }))
    await user.click(screen.getByRole("button", { name: "undo" }))
    expect(content).toBe("before")
  })
})

/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { HunkReviewItem } from "./hunk-review-item"
import type { GitHunk } from "@/types/git"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const hunk: GitHunk = {
  header: "@@ -1,2 +1,3 @@",
  oldStart: 1,
  oldLines: 2,
  newStart: 1,
  newLines: 3,
  patch: "patch",
  lines: [
    { kind: "context", content: "keep" },
    { kind: "add", content: "added" },
    { kind: "del", content: "removed" },
  ],
}

function setup(over: Partial<React.ComponentProps<typeof HunkReviewItem>> = {}) {
  const onDecision = jest.fn()
  const onComment = jest.fn()
  render(
    <HunkReviewItem
      hunk={hunk}
      index={2}
      decision="undecided"
      onDecision={onDecision}
      onComment={onComment}
      {...over}
    />
  )
  return { onDecision, onComment }
}

describe("HunkReviewItem", () => {
  it("renders accept/reject with aria-pressed reflecting the decision", () => {
    setup({ decision: "accepted" })
    expect(screen.getByTestId("hunk-accept")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("hunk-reject")).toHaveAttribute("aria-pressed", "false")
  })

  it("emits a decision for the hunk index, and toggles it off when re-clicked", async () => {
    const { onDecision } = setup({ decision: "undecided" })
    await userEvent.click(screen.getByTestId("hunk-accept"))
    expect(onDecision).toHaveBeenCalledWith(2, "accepted")
  })

  it("clears the decision when the active choice is clicked again", async () => {
    const { onDecision } = setup({ decision: "rejected" })
    await userEvent.click(screen.getByTestId("hunk-reject"))
    expect(onDecision).toHaveBeenCalledWith(2, "undecided")
  })

  it("reveals the comment box and forwards edits", async () => {
    const { onComment } = setup()
    expect(screen.queryByTestId("hunk-comment")).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId("hunk-comment-toggle"))
    await userEvent.type(screen.getByTestId("hunk-comment"), "x")
    expect(onComment).toHaveBeenCalledWith(2, "x")
  })

  it("disables the controls when disabled", () => {
    setup({ disabled: true })
    expect(screen.getByTestId("hunk-accept")).toBeDisabled()
    expect(screen.getByTestId("hunk-reject")).toBeDisabled()
  })

  it("uses touch-sized review controls in touch density", () => {
    setup({ density: "touch" })
    expect(screen.getByTestId("hunk-accept")).toHaveClass("h-11", "min-w-11")
    expect(screen.getByTestId("hunk-reject")).toHaveClass("h-11", "min-w-11")
    expect(screen.getByTestId("hunk-comment-toggle")).toHaveClass("h-11", "min-w-11")
  })

  it("renders the AI finding banner with severity + note when present", () => {
    setup({ ai: { severity: "critical", note: "possible null deref" } })
    const banner = screen.getByTestId("hunk-ai-finding")
    expect(banner).toHaveAttribute("data-severity", "critical")
    expect(banner).toHaveTextContent("possible null deref")
    expect(banner).toHaveTextContent("ai.severity.critical")
  })

  it("omits the AI banner when there is no finding", () => {
    setup()
    expect(screen.queryByTestId("hunk-ai-finding")).not.toBeInTheDocument()
  })
})

describe("HunkReviewItem bound to the diff", () => {
  it("offers the viewer's own hunk actions on the item", async () => {
    const user = userEvent.setup()
    const stage = jest.fn()
    const discard = jest.fn()
    setup({
      actions: [
        { icon: "stage", label: "Stage Hunk", onClick: stage },
        { icon: "discard", label: "Discard Hunk", onClick: discard },
      ],
    })
    await user.click(screen.getByRole("button", { name: "Stage Hunk" }))
    expect(stage).toHaveBeenCalledWith(hunk)
    await user.click(screen.getByTestId("hunk-review-discard"))
    expect(discard).toHaveBeenCalledWith(hunk)
  })

  it("reveals its hunk in the diff instead of drawing the lines again", async () => {
    const user = userEvent.setup()
    const onReveal = jest.fn()
    setup({ onReveal })
    expect(screen.queryByText("added")).toBeNull()
    await user.click(screen.getByTestId("hunk-reveal"))
    expect(onReveal).toHaveBeenCalledWith(2)
  })

  it("marks and scrolls to the hunk the reader is on in the diff", () => {
    const scrollIntoView = jest.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    setup({ current: true })
    const item = screen.getByTestId("hunk-review-item")
    expect(item).toHaveAttribute("data-current", "true")
    expect(item).toHaveAttribute("aria-current", "true")
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" })
  })
})

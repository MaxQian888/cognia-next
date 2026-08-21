/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { statusCategoryOf } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { DeleteIssueDialog } from "./delete-issue-dialog"

let seq = 0
function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  seq += 1
  return {
    unifiedId: `local:s${seq}`,
    kind: "local",
    sourceId: `s${seq}`,
    identifier: `MERC-${seq}`,
    title: `Issue ${seq}`,
    status: "todo",
    statusCategory: statusCategoryOf("todo"),
    priority: "none",
    labelIds: [],
    order: seq,
    createdAt: seq,
    updatedAt: seq,
    origin: { deepLinkHref: "/issues" },
    capabilities: FULL_ISSUE_CAPABILITIES,
    ...over,
  }
}

beforeEach(() => {
  seq = 0
})

describe("DeleteIssueDialog", () => {
  it("renders nothing while shut", () => {
    render(
      <DeleteIssueDialog
        open={false}
        onOpenChange={jest.fn()}
        items={[item()]}
        onConfirm={jest.fn()}
      />
    )
    expect(screen.queryByTestId("issue-delete-dialog")).not.toBeInTheDocument()
  })

  it("names the single issue it would delete", () => {
    render(
      <DeleteIssueDialog open onOpenChange={jest.fn()} items={[item()]} onConfirm={jest.fn()} />
    )
    expect(screen.getByText("delete.titleOne:MERC-1")).toBeInTheDocument()
  })

  it("counts a bulk delete instead", () => {
    render(
      <DeleteIssueDialog
        open
        onOpenChange={jest.fn()}
        items={[item(), item()]}
        onConfirm={jest.fn()}
      />
    )
    expect(screen.getByText("delete.titleMany:2")).toBeInTheDocument()
  })

  it("says what else goes with it, since the delete cascades", () => {
    render(
      <DeleteIssueDialog open onOpenChange={jest.fn()} items={[item()]} onConfirm={jest.fn()} />
    )
    expect(screen.getByText("delete.bodyOne:Issue 1")).toBeInTheDocument()
  })

  it("confirms", async () => {
    const onConfirm = jest.fn()
    render(
      <DeleteIssueDialog open onOpenChange={jest.fn()} items={[item()]} onConfirm={onConfirm} />
    )
    fireEvent.click(screen.getByTestId("issue-delete-confirm"))
    await waitFor(() => expect(onConfirm).toHaveBeenCalled())
  })

  it("stays up until a slow delete finishes, so it cannot look like a no-op", async () => {
    let release: () => void = () => undefined
    const onConfirm = jest.fn(() => new Promise<void>((resolve) => (release = resolve)))
    const onOpenChange = jest.fn()
    render(
      <DeleteIssueDialog open onOpenChange={onOpenChange} items={[item()]} onConfirm={onConfirm} />
    )
    fireEvent.click(screen.getByTestId("issue-delete-confirm"))
    await waitFor(() => expect(screen.getByTestId("issue-delete-confirm")).toBeDisabled())
    expect(onOpenChange).not.toHaveBeenCalled()
    release()
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("cannot confirm an empty selection", () => {
    render(<DeleteIssueDialog open onOpenChange={jest.fn()} items={[]} onConfirm={jest.fn()} />)
    expect(screen.getByTestId("issue-delete-confirm")).toBeDisabled()
  })
})

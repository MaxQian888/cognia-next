/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))
const mockQueue = jest.fn(async (..._a: unknown[]) => ({ id: "job" }))
jest.mock("@/lib/issues/remote-write", () => ({
  ...jest.requireActual("@/lib/issues/remote-write"),
  queueIssueAction: (...a: unknown[]) => mockQueue(...a),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
let pickerOnChange: ((actor: unknown) => void) | null = null
jest.mock("@/components/issues/assignee-picker", () => ({
  AssigneePicker: (props: { onChange: (actor: unknown) => void }) => {
    pickerOnChange = props.onChange
    return <div data-testid="assignee-picker-stub" />
  },
}))

import { act, fireEvent, render, screen } from "@testing-library/react"
import { toast } from "sonner"
import { statusCategoryOf } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { IssueMobileActions } from "./issue-mobile-actions"

function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  return {
    unifiedId: "local:i1",
    kind: "local",
    sourceId: "i1",
    identifier: "MERC-1",
    title: "Ship",
    status: "todo",
    statusCategory: statusCategoryOf("todo"),
    priority: "none",
    labelIds: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    origin: { deepLinkHref: "/issues" },
    capabilities: FULL_ISSUE_CAPABILITIES,
    ...over,
  }
}

beforeEach(() => {
  mockQueue.mockClear()
  ;(toast.success as jest.Mock).mockClear()
  ;(toast.error as jest.Mock).mockClear()
  pickerOnChange = null
})

describe("IssueMobileActions", () => {
  it("queues a status move for the host instead of writing locally", async () => {
    render(<IssueMobileActions item={item()} />)
    await act(async () => {
      fireEvent.change(screen.getByTestId("issues-mobile-status"), { target: { value: "done" } })
    })
    expect(mockQueue).toHaveBeenCalledWith({
      issueId: "i1",
      identifier: "MERC-1",
      action: { kind: "status", to: "done" },
    })
    expect(toast.success).toHaveBeenCalledWith("mobile.queued:MERC-1")
  })

  it("does not queue a move to the status the issue already has", async () => {
    render(<IssueMobileActions item={item()} />)
    await act(async () => {
      fireEvent.change(screen.getByTestId("issues-mobile-status"), { target: { value: "todo" } })
    })
    expect(mockQueue).not.toHaveBeenCalled()
  })

  it("queues an assignee change through the shared picker", async () => {
    render(<IssueMobileActions item={item()} />)
    await act(async () => {
      pickerOnChange?.({ kind: "human", label: "Me" })
    })
    expect(mockQueue).toHaveBeenCalledWith(
      expect.objectContaining({ action: { kind: "assignee", to: { kind: "human", label: "Me" } } })
    )
  })

  it("queues a trimmed comment and clears the box only once the queue accepted it", async () => {
    render(<IssueMobileActions item={item()} />)
    const box = screen.getByTestId("issues-mobile-comment")
    expect(screen.getByTestId("issues-mobile-comment-send")).toBeDisabled()
    fireEvent.change(box, { target: { value: "  looks good  " } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("issues-mobile-comment-send"))
    })
    expect(mockQueue).toHaveBeenCalledWith(
      expect.objectContaining({ action: { kind: "comment", body: "looks good" } })
    )
    expect(box).toHaveValue("")
  })

  it("keeps the comment and says why when the queue refuses", async () => {
    mockQueue.mockRejectedValueOnce(new Error("Outbound queue requires an active account and runtime target."))
    render(<IssueMobileActions item={item()} />)
    fireEvent.change(screen.getByTestId("issues-mobile-comment"), { target: { value: "hi" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("issues-mobile-comment-send"))
    })
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("runtime target"))
    expect(screen.getByTestId("issues-mobile-comment")).toHaveValue("hi")
  })

  it("hides each control whose capability bit is off", () => {
    render(
      <IssueMobileActions
        item={item({
          capabilities: { ...FULL_ISSUE_CAPABILITIES, canMove: false, canComment: false },
        })}
      />
    )
    expect(screen.queryByTestId("issues-mobile-status")).not.toBeInTheDocument()
    expect(screen.queryByTestId("issues-mobile-comment")).not.toBeInTheDocument()
    expect(screen.getByTestId("assignee-picker-stub")).toBeInTheDocument()
  })

  it("accepts an issue out of triage and sends one back, as queued actions", async () => {
    const { unmount } = render(<IssueMobileActions item={item({ triage: "pending" })} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("issue-detail-triage-accept"))
    })
    expect(mockQueue).toHaveBeenLastCalledWith({
      issueId: "i1",
      identifier: "MERC-1",
      action: { kind: "triage", to: null },
    })
    unmount()
    render(<IssueMobileActions item={item()} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("issue-detail-triage-send"))
    })
    expect(mockQueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: { kind: "triage", to: "pending" } })
    )
  })

  it("commits a sub-issue's stage once, on blur, and never a half-typed value", async () => {
    render(<IssueMobileActions item={item({ parentId: "p1", stage: 1 })} />)
    const box = screen.getByTestId("issues-mobile-stage")
    fireEvent.change(box, { target: { value: "1" } })
    fireEvent.change(box, { target: { value: "12" } })
    expect(mockQueue).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.blur(box)
    })
    expect(mockQueue).toHaveBeenCalledTimes(1)
    expect(mockQueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: { kind: "stage", to: 12 } })
    )
    // Out of range is dropped; an empty box unstages; the same stage is no edit.
    mockQueue.mockClear()
    fireEvent.change(box, { target: { value: "0" } })
    await act(async () => {
      fireEvent.blur(box)
    })
    fireEvent.change(box, { target: { value: "1" } })
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" })
    })
    expect(mockQueue).not.toHaveBeenCalled()
    fireEvent.change(box, { target: { value: "" } })
    await act(async () => {
      fireEvent.blur(box)
    })
    expect(mockQueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: { kind: "stage", to: null } })
    )
  })

  it("offers no stage box on a top-level issue or without edit rights", () => {
    const { unmount } = render(<IssueMobileActions item={item()} />)
    expect(screen.queryByTestId("issues-mobile-stage")).not.toBeInTheDocument()
    unmount()
    render(
      <IssueMobileActions
        item={item({
          parentId: "p1",
          capabilities: { ...FULL_ISSUE_CAPABILITIES, canEdit: false },
        })}
      />
    )
    expect(screen.queryByTestId("issues-mobile-stage")).not.toBeInTheDocument()
  })
})

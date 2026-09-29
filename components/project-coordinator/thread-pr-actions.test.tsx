/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChatSession } from "@cognia/agent-config-types"

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))
jest.mock("@/lib/project-coordinator/thread-runtime", () => ({
  sendToThread: jest.fn(async () => true),
}))
jest.mock("@/lib/project-coordinator/pr-actions", () => ({
  ...jest.requireActual("@/lib/project-coordinator/pr-actions"),
  mergeThreadPr: jest.fn(async () => undefined),
  createThreadPr: jest.fn(async () => ({ number: 1, url: "u", created: true })),
}))

import { sendToThread } from "@/lib/project-coordinator/thread-runtime"
import { createThreadPr, mergeThreadPr } from "@/lib/project-coordinator/pr-actions"
import { ThreadPrActions } from "./thread-pr-actions"

const thread = (pr = true) =>
  ({
    id: "t1",
    title: "Fix login",
    createdAt: 1,
    updatedAt: 1,
    executionContext: { branch: "thread/x", worktreePath: "/wt/x" },
    projectThread: {
      coordinatorSessionId: "c",
      brief: "b",
      proposedBy: "user",
      ...(pr
        ? {
            prRef: {
              repo: "o/n",
              branch: "thread/x",
              number: 7,
              url: "https://github.com/o/n/pull/7",
            },
          }
        : {}),
    },
  }) as unknown as ChatSession

beforeEach(() => jest.clearAllMocks())

describe("ThreadPrActions", () => {
  it("shows the PR status and sends the fix-CI instruction into the thread", async () => {
    render(<ThreadPrActions thread={thread()} pr="ci_failed" />)
    expect(screen.getByText("CI failed")).toBeInTheDocument()
    expect(screen.getByTestId("thread-pr-review-t1").getAttribute("href")).toBe(
      "https://github.com/o/n/pull/7"
    )
    fireEvent.click(screen.getByTestId("thread-pr-fix-ci-t1"))
    await waitFor(() =>
      expect(sendToThread).toHaveBeenCalledWith("t1", expect.stringContaining("CI failed"))
    )
  })

  it("reports when the thread cannot take the instruction", async () => {
    ;(sendToThread as jest.Mock).mockResolvedValueOnce(false)
    render(<ThreadPrActions thread={thread()} pr="changes_requested" />)
    fireEvent.click(screen.getByTestId("thread-pr-address-comments-t1"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("The thread could not take the instruction now.")
    )
  })

  it("merges only after confirmation", async () => {
    const user = userEvent.setup()
    render(<ThreadPrActions thread={thread()} pr="mergeable" />)
    await user.click(screen.getByTestId("thread-pr-merge-t1"))
    expect(mergeThreadPr).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Merge" }))
    await waitFor(() => expect(mergeThreadPr).toHaveBeenCalled())
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Pull request merged."))
  })

  it("publishes a branch without a PR, and renders nothing when nothing applies", async () => {
    render(<ThreadPrActions thread={thread(false)} />)
    fireEvent.click(screen.getByTestId("thread-pr-create-t1"))
    await waitFor(() => expect(createThreadPr).toHaveBeenCalled())
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Pull request opened."))

    const { container } = render(
      <ThreadPrActions
        thread={{ id: "x", title: "x", createdAt: 1, updatedAt: 1 } as ChatSession}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})

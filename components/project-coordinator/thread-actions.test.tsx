/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const toastInfo = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    info: (...a: unknown[]) => toastInfo(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))
jest.mock("@/lib/project-coordinator/thread-runtime", () => ({
  startThread: jest.fn(),
  stopThread: jest.fn(async () => undefined),
  resolveThread: jest.fn(async () => true),
  reopenThread: jest.fn(async () => undefined),
}))

import {
  reopenThread,
  resolveThread,
  startThread,
  stopThread,
} from "@/lib/project-coordinator/thread-runtime"
import { ThreadActions } from "./thread-actions"

beforeEach(() => jest.clearAllMocks())

describe("ThreadActions", () => {
  it("starts a staged thread as the user and explains a refusal", async () => {
    ;(startThread as jest.Mock).mockResolvedValue({ kind: "refuse", reason: "paused" })
    render(<ThreadActions threadId="t1" title="Fix" state="staged" />)
    fireEvent.click(screen.getByTestId("thread-start-t1"))
    await waitFor(() => expect(startThread).toHaveBeenCalledWith("t1", "user"))
    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith("The project is paused."))
  })

  it("offers stop while working and resolve otherwise", async () => {
    const { rerender } = render(<ThreadActions threadId="t1" title="Fix" state="working" />)
    expect(screen.queryByTestId("thread-resolve-t1")).toBeNull()
    fireEvent.click(screen.getByTestId("thread-stop-t1"))
    await waitFor(() => expect(stopThread).toHaveBeenCalledWith("t1"))

    rerender(<ThreadActions threadId="t1" title="Fix" state="idle" />)
    expect(screen.queryByTestId("thread-stop-t1")).toBeNull()
    fireEvent.click(screen.getByTestId("thread-resolve-t1"))
    await waitFor(() => expect(resolveThread).toHaveBeenCalledWith("t1", "user"))
  })

  it("reopens a resolved thread and reports failures", async () => {
    ;(reopenThread as jest.Mock).mockRejectedValueOnce(new Error("offline"))
    render(<ThreadActions threadId="t1" title="Fix" state="resolved" />)
    fireEvent.click(screen.getByTestId("thread-reopen-t1"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("The thread action failed: offline")
    )
    expect(screen.getByRole("group", { name: "Thread actions for Fix" })).toBeInTheDocument()
  })
})

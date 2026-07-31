/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const mockSetStatus = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/conversation-overrides", () => ({
  setStatus: (...a: unknown[]) => mockSetStatus(...a),
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

import { toast } from "sonner"
import { LifecycleStatusChip } from "./lifecycle-status-chip"

const mockToastError = toast.error as jest.Mock

beforeEach(() => jest.clearAllMocks())

describe("LifecycleStatusChip", () => {
  it("renders the current status label", () => {
    render(<LifecycleStatusChip conversationKey="k" sessionId="s" status="pending" />)
    expect(screen.getByTestId("lifecycle-status-chip")).toHaveTextContent("Pending")
  })

  it("applies a top-level status from the menu", async () => {
    const user = userEvent.setup()
    render(<LifecycleStatusChip conversationKey="k" sessionId="s" status="open" />)
    await user.click(screen.getByTestId("lifecycle-status-chip"))
    await user.click(await screen.findByText("Resolved"))
    await waitFor(() =>
      expect(mockSetStatus).toHaveBeenCalledWith("k", "resolved", {
        sessionId: "s",
        snoozeUntil: undefined,
      })
    )
  })

  it("surfaces a toast when setStatus rejects", async () => {
    mockSetStatus.mockRejectedValueOnce(new Error("boom"))
    const user = userEvent.setup()
    render(<LifecycleStatusChip conversationKey="k" sessionId="s" status="open" />)
    await user.click(screen.getByTestId("lifecycle-status-chip"))
    await user.click(await screen.findByText("Pending"))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("boom"))
  })
})

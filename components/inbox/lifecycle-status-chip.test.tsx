/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const mockMutate = jest.fn().mockResolvedValue({ route: "local", conversationKey: "k" })
// ADR-0131: override writes go through the shell-agnostic facade, which
// picks local-host vs. relay-to-paired-host. The control just describes
// its edit as one mutation.
jest.mock("@/lib/connectors/inbox-writes", () => ({
  mutateConversationOverride: (...a: unknown[]) => mockMutate(...a),
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
      expect(mockMutate).toHaveBeenCalledWith({
        kind: "setStatus",
        conversationKey: "k",
        status: "resolved",
        sessionId: "s",
        snoozeUntil: undefined,
      })
    )
  })

  it("surfaces a toast when the write rejects", async () => {
    mockMutate.mockRejectedValueOnce(new Error("boom"))
    const user = userEvent.setup()
    render(<LifecycleStatusChip conversationKey="k" sessionId="s" status="open" />)
    await user.click(screen.getByTestId("lifecycle-status-chip"))
    await user.click(await screen.findByText("Pending"))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("boom"))
  })
})

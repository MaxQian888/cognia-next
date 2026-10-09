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
import { LifecycleStatusChip, SNOOZE_PRESETS, snoozeUntilFor } from "./lifecycle-status-chip"

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

describe("snooze presets", () => {
  it("offers 1h, 8h and 24h", () => {
    expect(SNOOZE_PRESETS.map((preset) => preset.key)).toEqual(["1h", "8h", "24h"])
  })

  it("computes the end of a snooze from an injected clock", () => {
    expect(snoozeUntilFor("8h", 1_000)).toBe(1_000 + 8 * 60 * 60 * 1000)
  })

  it("refuses an unknown preset", () => {
    expect(() => snoozeUntilFor("2d" as never, 0)).toThrow("Unknown snooze preset")
  })
})

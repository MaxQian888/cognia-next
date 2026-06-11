/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ConversationLabelRow } from "@/lib/db/crm-types"

const mockAddLabel = jest.fn().mockResolvedValue(undefined)
const mockRemoveLabel = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/conversation-overrides", () => ({
  addLabel: (...a: unknown[]) => mockAddLabel(...a),
  removeLabel: (...a: unknown[]) => mockRemoveLabel(...a),
}))

const CATALOG: ConversationLabelRow[] = [
  { id: "l1", name: "VIP", color: "#f00", sortOrder: 0, createdAt: 0, updatedAt: 0 },
  { id: "l2", name: "Bug", sortOrder: 1, createdAt: 0, updatedAt: 0 },
]
jest.mock("@/hooks/connectors/use-conversation-labels", () => ({
  useConversationLabels: () => CATALOG,
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

import { toast } from "sonner"
import { LabelPicker } from "./label-picker"

beforeEach(() => jest.clearAllMocks())

describe("LabelPicker", () => {
  it("renders the currently-selected labels as chips", () => {
    render(<LabelPicker conversationKey="k" sessionId="s" selectedIds={["l1"]} />)
    expect(screen.getByTestId("label-chip-l1")).toHaveTextContent("VIP")
    expect(screen.queryByTestId("label-chip-l2")).not.toBeInTheDocument()
  })

  it("adds an unselected label from the popover", async () => {
    const user = userEvent.setup()
    render(<LabelPicker conversationKey="k" sessionId="s" selectedIds={["l1"]} />)
    await user.click(screen.getByTestId("label-picker-trigger"))
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /Bug/ }))
    await waitFor(() => expect(mockAddLabel).toHaveBeenCalledWith("k", "l2", "s"))
  })

  it("removes a selected label from the popover", async () => {
    const user = userEvent.setup()
    render(<LabelPicker conversationKey="k" sessionId="s" selectedIds={["l1"]} />)
    await user.click(screen.getByTestId("label-picker-trigger"))
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /VIP/ }))
    await waitFor(() => expect(mockRemoveLabel).toHaveBeenCalledWith("k", "l1", "s"))
  })

  it("removes a label via the chip × affordance", async () => {
    const user = userEvent.setup()
    render(<LabelPicker conversationKey="k" sessionId="s" selectedIds={["l1"]} />)
    await user.click(screen.getByRole("button", { name: /Remove label VIP/i }))
    await waitFor(() => expect(mockRemoveLabel).toHaveBeenCalledWith("k", "l1", "s"))
  })

  it("surfaces a toast when a toggle rejects", async () => {
    mockAddLabel.mockRejectedValueOnce(new Error("dup"))
    const user = userEvent.setup()
    render(<LabelPicker conversationKey="k" sessionId="s" selectedIds={[]} />)
    await user.click(screen.getByTestId("label-picker-trigger"))
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /Bug/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("dup"))
  })
})

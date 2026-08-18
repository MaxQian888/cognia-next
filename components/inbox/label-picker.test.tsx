/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ConversationLabelRow } from "@/lib/db/crm-types"

const mockMutate = jest.fn().mockResolvedValue({ route: "local", conversationKey: "k" })
// ADR-0131: override writes go through the shell-agnostic facade, which
// picks local-host vs. relay-to-paired-host. The control just describes
// its edit as one mutation.
jest.mock("@/lib/connectors/inbox-writes", () => ({
  mutateConversationOverride: (...a: unknown[]) => mockMutate(...a),
}))

const CATALOG: ConversationLabelRow[] = [
  {
    id: "l1",
    scope: "conversation",
    name: "VIP",
    color: "#f00",
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  },
  { id: "l2", scope: "conversation", name: "Bug", sortOrder: 1, createdAt: 0, updatedAt: 0 },
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
    await waitFor(() => expect(mockMutate).toHaveBeenCalledWith({
        kind: "addLabel",
        conversationKey: "k",
        labelId: "l2",
        sessionId: "s",
      }))
  })

  it("removes a selected label from the popover", async () => {
    const user = userEvent.setup()
    render(<LabelPicker conversationKey="k" sessionId="s" selectedIds={["l1"]} />)
    await user.click(screen.getByTestId("label-picker-trigger"))
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /VIP/ }))
    await waitFor(() => expect(mockMutate).toHaveBeenCalledWith({
        kind: "removeLabel",
        conversationKey: "k",
        labelId: "l1",
        sessionId: "s",
      }))
  })

  it("removes a label via the chip × affordance", async () => {
    const user = userEvent.setup()
    render(<LabelPicker conversationKey="k" sessionId="s" selectedIds={["l1"]} />)
    await user.click(screen.getByRole("button", { name: /Remove label VIP/i }))
    await waitFor(() => expect(mockMutate).toHaveBeenCalledWith({
        kind: "removeLabel",
        conversationKey: "k",
        labelId: "l1",
        sessionId: "s",
      }))
  })

  it("surfaces a toast when a toggle rejects", async () => {
    mockMutate.mockRejectedValueOnce(new Error("dup"))
    const user = userEvent.setup()
    render(<LabelPicker conversationKey="k" sessionId="s" selectedIds={[]} />)
    await user.click(screen.getByTestId("label-picker-trigger"))
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /Bug/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("dup"))
  })
})

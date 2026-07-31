/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const mockSetAssignee = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/conversation-overrides", () => ({
  setAssignee: (...a: unknown[]) => mockSetAssignee(...a),
}))
const mockUseCharacters = jest.fn()
jest.mock("@/lib/data-hooks/context", () => ({
  useCharacters: () => mockUseCharacters(),
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

import { toast } from "sonner"
import { AssigneeChip } from "./assignee-chip"
import type { ConversationAssignee } from "@/lib/db/conversation-overrides"

const mockToastError = toast.error as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  mockUseCharacters.mockReturnValue([
    { id: "char-1", name: "Ava" },
    { id: "char-2", name: "Bo" },
  ])
})

describe("AssigneeChip", () => {
  it("renders 'Unassigned' when there is no assignee", () => {
    render(<AssigneeChip conversationKey="k" sessionId="s" />)
    expect(screen.getByTestId("assignee-chip")).toHaveTextContent("Unassigned")
  })

  it("renders 'Me' for a human assignee", () => {
    const me: ConversationAssignee = { kind: "human" }
    render(<AssigneeChip conversationKey="k" sessionId="s" assignee={me} />)
    expect(screen.getByTestId("assignee-chip")).toHaveTextContent("Me")
  })

  it("renders the character label for a character assignee", () => {
    const ava: ConversationAssignee = { kind: "character", id: "char-1", label: "Ava" }
    render(<AssigneeChip conversationKey="k" sessionId="s" assignee={ava} />)
    expect(screen.getByTestId("assignee-chip")).toHaveTextContent("Ava")
  })

  it("assigns to me from the menu", async () => {
    const user = userEvent.setup()
    render(<AssigneeChip conversationKey="k" sessionId="s" />)
    await user.click(screen.getByTestId("assignee-chip"))
    await user.click(await screen.findByText("Me"))
    await waitFor(() =>
      expect(mockSetAssignee).toHaveBeenCalledWith(
        "k",
        { kind: "human" },
        { sessionId: "s", via: "manual" }
      )
    )
  })

  it("assigns to a character from the submenu", async () => {
    const user = userEvent.setup()
    render(<AssigneeChip conversationKey="k" sessionId="s" />)
    await user.click(screen.getByTestId("assignee-chip"))
    await user.click(await screen.findByText("Bo"))
    await waitFor(() =>
      expect(mockSetAssignee).toHaveBeenCalledWith(
        "k",
        { kind: "character", id: "char-2", label: "Bo" },
        { sessionId: "s", via: "manual" }
      )
    )
  })

  it("unassigns from the menu", async () => {
    const assigned: ConversationAssignee = { kind: "character", id: "char-1", label: "Ava" }
    const user = userEvent.setup()
    render(<AssigneeChip conversationKey="k" sessionId="s" assignee={assigned} />)
    await user.click(screen.getByTestId("assignee-chip"))
    await user.click(await screen.findByText("Unassign"))
    await waitFor(() =>
      expect(mockSetAssignee).toHaveBeenCalledWith("k", null, {
        sessionId: "s",
        via: "manual",
      })
    )
  })

  it("surfaces a toast when setAssignee rejects", async () => {
    mockSetAssignee.mockRejectedValueOnce(new Error("boom"))
    const user = userEvent.setup()
    render(<AssigneeChip conversationKey="k" sessionId="s" />)
    await user.click(screen.getByTestId("assignee-chip"))
    await user.click(await screen.findByText("Me"))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("boom"))
  })

  it("stringifies non-Error rejections in the toast", async () => {
    mockSetAssignee.mockRejectedValueOnce("plain string failure")
    const user = userEvent.setup()
    render(<AssigneeChip conversationKey="k" sessionId="s" />)
    await user.click(screen.getByTestId("assignee-chip"))
    await user.click(await screen.findByText("Me"))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("plain string failure"))
  })

  it("renders a team assignee label and falls back when labels are absent", () => {
    const team: ConversationAssignee = { kind: "team", id: "t1", label: "Support" }
    const { rerender } = render(<AssigneeChip conversationKey="k" sessionId="s" assignee={team} />)
    expect(screen.getByTestId("assignee-chip")).toHaveTextContent("Support")
    rerender(<AssigneeChip conversationKey="k" sessionId="s" assignee={{ kind: "team" }} />)
    expect(screen.getByTestId("assignee-chip")).toHaveTextContent("Team")
    rerender(<AssigneeChip conversationKey="k" sessionId="s" assignee={{ kind: "character" }} />)
    expect(screen.getByTestId("assignee-chip")).toHaveTextContent("Character")
  })

  it("hides the character section when there are no characters", async () => {
    mockUseCharacters.mockReturnValue([])
    const user = userEvent.setup()
    render(<AssigneeChip conversationKey="k" sessionId="s" />)
    await user.click(screen.getByTestId("assignee-chip"))
    expect(await screen.findByText("Me")).toBeInTheDocument()
    expect(screen.queryByText("Ava")).not.toBeInTheDocument()
  })
})

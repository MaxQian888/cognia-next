/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { ConversationLabelRow } from "@/lib/db/crm-types"

const mockCreateLabel = jest.fn().mockResolvedValue({ id: "new" })
const mockUpdateLabel = jest.fn().mockResolvedValue(undefined)
const mockDeleteLabel = jest.fn().mockResolvedValue(undefined)
let mockLabels: ConversationLabelRow[] = []

jest.mock("@/hooks/connectors/use-conversation-labels", () => ({
  useConversationLabels: () => mockLabels,
}))
jest.mock("@/lib/db/conversation-labels", () => ({
  createLabel: (...a: unknown[]) => mockCreateLabel(...a),
  updateLabel: (...a: unknown[]) => mockUpdateLabel(...a),
  deleteLabel: (...a: unknown[]) => mockDeleteLabel(...a),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
import { LabelsTab } from "./labels-tab"

const mockToastError = toast.error as jest.Mock

function label(p: Partial<ConversationLabelRow>): ConversationLabelRow {
  return {
    id: "l1",
    name: "VIP",
    color: "#ff0000",
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    ...p,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockLabels = []
})

describe("LabelsTab", () => {
  it("shows the empty state when there are no labels", () => {
    render(<LabelsTab />)
    expect(screen.getByTestId("labels-list")).toHaveTextContent(/no labels yet/i)
  })

  it("creates a label from the form (name + chosen color)", async () => {
    render(<LabelsTab />)
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Urgent" } })
    fireEvent.change(screen.getByLabelText("Color"), { target: { value: "#123456" } })
    fireEvent.click(screen.getByRole("button", { name: /add label/i }))
    await waitFor(() => {
      expect(mockCreateLabel).toHaveBeenCalledWith({ name: "Urgent", color: "#123456" })
    })
  })

  it("blocks creating a blank label with an error toast", async () => {
    render(<LabelsTab />)
    fireEvent.click(screen.getByRole("button", { name: /add label/i }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockCreateLabel).not.toHaveBeenCalled()
  })

  it("renames a label on blur", async () => {
    mockLabels = [label({ id: "l1", name: "VIP" })]
    render(<LabelsTab />)
    const input = screen.getByLabelText("Name for VIP")
    fireEvent.change(input, { target: { value: "VIP Gold" } })
    fireEvent.blur(input)
    await waitFor(() => {
      expect(mockUpdateLabel).toHaveBeenCalledWith("l1", { name: "VIP Gold" })
    })
  })

  it("deletes a non-built-in label and protects built-ins (no delete button + badge)", async () => {
    mockLabels = [
      label({ id: "user", name: "User", builtin: false }),
      label({ id: "bi", name: "Built", builtin: true }),
    ]
    render(<LabelsTab />)
    // Built-in shows badge, no delete button.
    expect(screen.queryByRole("button", { name: /delete label built/i })).toBeNull()
    expect(screen.getByText("Built-in")).toBeInTheDocument()
    // User label deletes.
    fireEvent.click(screen.getByRole("button", { name: /delete label user/i }))
    await waitFor(() => expect(mockDeleteLabel).toHaveBeenCalledWith("user"))
  })

  it("does not rename when the value is unchanged or blank", async () => {
    mockLabels = [label({ id: "l1", name: "VIP" })]
    render(<LabelsTab />)
    const input = screen.getByLabelText("Name for VIP")
    fireEvent.blur(input) // unchanged
    fireEvent.change(input, { target: { value: "   " } })
    fireEvent.blur(input) // blank
    expect(mockUpdateLabel).not.toHaveBeenCalled()
  })

  it("recolors a label via the row color input (defaults a colorless row)", async () => {
    mockLabels = [label({ id: "l1", name: "VIP", color: undefined })]
    render(<LabelsTab />)
    fireEvent.change(screen.getByLabelText("Color for VIP"), { target: { value: "#00ff00" } })
    await waitFor(() => expect(mockUpdateLabel).toHaveBeenCalledWith("l1", { color: "#00ff00" }))
  })

  it("surfaces a toast when createLabel rejects", async () => {
    mockCreateLabel.mockRejectedValueOnce(new Error("dup name"))
    render(<LabelsTab />)
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Urgent" } })
    fireEvent.click(screen.getByRole("button", { name: /add label/i }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("dup name"))
  })

  it("surfaces a toast when deleteLabel rejects", async () => {
    mockDeleteLabel.mockRejectedValueOnce(new Error("nope"))
    mockLabels = [label({ id: "u", name: "User", builtin: false })]
    render(<LabelsTab />)
    fireEvent.click(screen.getByRole("button", { name: /delete label user/i }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("nope"))
  })
})

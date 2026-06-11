/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { CannedResponseRow } from "@/lib/db/crm-types"

const mockCreate = jest.fn().mockResolvedValue({ id: "new" })
const mockUpdate = jest.fn().mockResolvedValue(undefined)
const mockDelete = jest.fn().mockResolvedValue(undefined)
let mockRows: CannedResponseRow[] = []

jest.mock("@/hooks/connectors/use-canned-responses", () => ({
  useCannedResponses: () => mockRows,
}))
jest.mock("@/lib/db/canned-responses", () => ({
  createCanned: (...a: unknown[]) => mockCreate(...a),
  updateCanned: (...a: unknown[]) => mockUpdate(...a),
  deleteCanned: (...a: unknown[]) => mockDelete(...a),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
import { CannedResponsesTab } from "./canned-responses-tab"

const mockToastError = toast.error as jest.Mock

function canned(p: Partial<CannedResponseRow>): CannedResponseRow {
  return {
    id: "c1",
    title: "Greeting",
    body: "Hi!",
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    ...p,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRows = []
})

describe("CannedResponsesTab", () => {
  it("shows the empty state when there are no canned responses", () => {
    render(<CannedResponsesTab />)
    expect(screen.getByTestId("canned-list")).toHaveTextContent(/no canned responses yet/i)
  })

  it("creates a canned response from title + body", async () => {
    render(<CannedResponsesTab />)
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Thanks" } })
    fireEvent.change(screen.getByLabelText("Body"), {
      target: { value: "Thank you {{contact.name}}" },
    })
    fireEvent.click(screen.getByRole("button", { name: /add canned response/i }))
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({
        title: "Thanks",
        body: "Thank you {{contact.name}}",
      })
    )
  })

  it("blocks creating when title or body is blank", async () => {
    render(<CannedResponsesTab />)
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Only title" } })
    fireEvent.click(screen.getByRole("button", { name: /add canned response/i }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("edits the body on blur", async () => {
    mockRows = [canned({ id: "c1", title: "Greeting", body: "Hi!" })]
    render(<CannedResponsesTab />)
    const input = screen.getByLabelText("Body for Greeting")
    fireEvent.change(input, { target: { value: "Hello there!" } })
    fireEvent.blur(input)
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith("c1", { body: "Hello there!" }))
  })

  it("deletes a user response and protects built-ins", async () => {
    mockRows = [
      canned({ id: "u", title: "User", isBuiltIn: false }),
      canned({ id: "bi", title: "Built", isBuiltIn: true }),
    ]
    render(<CannedResponsesTab />)
    expect(screen.queryByRole("button", { name: /delete built/i })).toBeNull()
    expect(screen.getByText("Built-in")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /delete user/i }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("u"))
  })

  it("surfaces a toast when createCanned rejects", async () => {
    mockCreate.mockRejectedValueOnce(new Error("boom"))
    render(<CannedResponsesTab />)
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "T" } })
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "B" } })
    fireEvent.click(screen.getByRole("button", { name: /add canned response/i }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("boom"))
  })
})

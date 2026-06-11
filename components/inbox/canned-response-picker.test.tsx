/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { CannedResponseRow } from "@/lib/db/crm-types"

const mockSetInput = jest.fn()
let mockValue = ""
jest.mock("@/components/ai-elements/prompt-input", () => ({
  usePromptInputController: () => ({ textInput: { value: mockValue, setInput: mockSetInput } }),
}))

const CANNED: CannedResponseRow[] = [
  {
    id: "c1",
    title: "Greeting",
    body: "Hi {{contact.name}}, thanks for reaching out!",
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  },
  { id: "c2", title: "Acknowledge", body: "Got it!", sortOrder: 1, createdAt: 0, updatedAt: 0 },
]
jest.mock("@/hooks/connectors/use-canned-responses", () => ({
  useCannedResponses: () => CANNED,
}))
const mockIncrementUsage = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/canned-responses", () => ({
  incrementUsage: (...a: unknown[]) => mockIncrementUsage(...a),
}))

import { CannedResponsePicker } from "./canned-response-picker"

beforeEach(() => {
  jest.clearAllMocks()
  mockValue = ""
})

describe("CannedResponsePicker", () => {
  it("inserts the interpolated canned body and bumps usage on select", async () => {
    const user = userEvent.setup()
    render(<CannedResponsePicker conversationKey="k" context={{ contact: { name: "Ada" } }} />)
    await user.click(screen.getByTestId("canned-response-trigger"))
    await user.click(await screen.findByText("Greeting"))
    await waitFor(() =>
      expect(mockSetInput).toHaveBeenCalledWith("Hi Ada, thanks for reaching out!")
    )
    expect(mockIncrementUsage).toHaveBeenCalledWith("c1")
  })

  it("appends to existing composer text with a separator", async () => {
    mockValue = "Hello"
    const user = userEvent.setup()
    render(<CannedResponsePicker conversationKey="k" context={{}} />)
    await user.click(screen.getByTestId("canned-response-trigger"))
    await user.click(await screen.findByText("Acknowledge"))
    await waitFor(() => expect(mockSetInput).toHaveBeenCalledWith("Hello Got it!"))
  })

  it("filters the list by the search query", async () => {
    const user = userEvent.setup()
    render(<CannedResponsePicker conversationKey="k" context={{}} />)
    await user.click(screen.getByTestId("canned-response-trigger"))
    await user.type(screen.getByTestId("canned-response-search"), "ack")
    expect(screen.queryByText("Greeting")).not.toBeInTheDocument()
    expect(screen.getByText("Acknowledge")).toBeInTheDocument()
  })
})

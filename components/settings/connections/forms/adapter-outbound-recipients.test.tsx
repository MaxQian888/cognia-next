/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { personTarget } from "@/lib/policy/action-review/outbound-targets"

let row: Record<string, unknown> | undefined
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => row }))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({}) }))
jest.mock("@/hooks/outbound/use-known-conversations", () => ({
  useKnownConversations: () => [],
}))
const setAdapterOutboundRecipients = jest.fn(async (_id: string, _next: unknown) => ({}))
jest.mock("@/lib/db/adapter-instances", () => ({
  setAdapterOutboundRecipients: (id: string, next: unknown) =>
    setAdapterOutboundRecipients(id, next),
}))
const success = jest.fn()
const error = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (m: string) => success(m), error: (m: string) => error(m) },
}))

import { AdapterOutboundRecipients } from "./adapter-outbound-recipients"

beforeEach(() => {
  row = { id: "bot-a", outboundRecipients: [] }
  setAdapterOutboundRecipients.mockClear()
  success.mockClear()
  error.mockClear()
})

async function addMember(memberId: string) {
  fireEvent.click(screen.getByRole("button", { name: "Person" }))
  fireEvent.change(screen.getByLabelText("Member id"), { target: { value: memberId } })
  fireEvent.click(screen.getByRole("button", { name: "Add" }))
}

describe("AdapterOutboundRecipients", () => {
  it("writes the account's list, members named within the account", async () => {
    render(<AdapterOutboundRecipients adapterId="bot-a" />)
    await addMember("ou_1")
    await waitFor(() => expect(setAdapterOutboundRecipients).toHaveBeenCalledTimes(1))
    expect(setAdapterOutboundRecipients).toHaveBeenCalledWith("bot-a", [
      {
        recipient: personTarget("bot-a", "ou_1"),
        addedAt: expect.any(Number),
        addedBy: "local-user",
      },
    ])
    expect(success).toHaveBeenCalledWith("Recipient list saved")
  })

  it("reports a refused write and keeps the entry unsaved", async () => {
    setAdapterOutboundRecipients.mockRejectedValueOnce(new Error("not this account"))
    render(<AdapterOutboundRecipients adapterId="bot-a" />)
    await addMember("ou_1")
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Could not save the recipient list: not this account")
    )
    expect(screen.getByLabelText("Member id")).toHaveValue("ou_1")
  })

  it("edits nothing until the row has loaded", () => {
    row = undefined
    render(<AdapterOutboundRecipients adapterId="bot-a" />)
    expect(screen.getByLabelText("Search, or paste a conversation key")).toBeDisabled()
  })
})

/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { KnownConversation } from "@/hooks/outbound/use-known-conversations"
import {
  conversationTarget,
  mailTarget,
  personTarget,
} from "@/lib/policy/action-review/outbound-targets"
import type { OutboundRecipientGrant } from "@cognia/agent-config-types/action-review"

import { OutboundRecipientsEditor } from "./outbound-recipients-editor"

const CHAT = conversationTarget("lark:bot-a:oc_1")!
const OTHER = conversationTarget("lark:bot-b:oc_9")!

function grant(target: {
  kind: string
  channel: string
  recipient: string
}): OutboundRecipientGrant {
  return {
    recipient: target as OutboundRecipientGrant["recipient"],
    addedAt: 1,
    addedBy: "local-user",
  }
}

const KNOWN: KnownConversation[] = [
  { target: CHAT, title: "Team chat", lastActivityAt: 2 },
  { target: OTHER, title: "Other bot's chat", lastActivityAt: 1 },
]

function setup(props: Partial<React.ComponentProps<typeof OutboundRecipientsEditor>> = {}) {
  const onSave = jest.fn(async (_next: OutboundRecipientGrant[]) => true)
  render(
    <OutboundRecipientsEditor
      value={[]}
      onSave={onSave}
      kinds={["conversation", "mail"]}
      knownConversations={KNOWN}
      {...props}
    />
  )
  return onSave
}

describe("OutboundRecipientsEditor", () => {
  it("says an empty list asks first", () => {
    setup()
    expect(screen.getByTestId("outbound-recipients-empty")).toHaveTextContent(
      "No one is listed. A send with nobody watching asks first."
    )
  })

  it("names a listed conversation by its known title, and removes it", async () => {
    const onSave = setup({ value: [grant(CHAT), grant(mailTarget("ops@example.com")!)] })
    expect(screen.getByText("Team chat")).toBeInTheDocument()
    expect(screen.getByText("via bot-a")).toBeInTheDocument()
    expect(screen.getByText("ops@example.com")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Remove Team chat" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0].map((entry) => entry.recipient.recipient)).toEqual([
      "mail:ops@example.com",
    ])
  })

  it("adds a known conversation by name, in the engine's form", async () => {
    const onSave = setup()
    fireEvent.click(screen.getByRole("button", { name: "Add Team chat" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0]).toEqual([
      { recipient: CHAT, addedAt: expect.any(Number), addedBy: "local-user" },
    ])
  })

  it("offers only chats not yet listed, filtered by what is typed", () => {
    setup({ value: [grant(CHAT)] })
    expect(screen.queryByRole("button", { name: "Add Team chat" })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Search, or paste a conversation key"), {
      target: { value: "nothing matches" },
    })
    expect(screen.queryByRole("button", { name: "Add Other bot's chat" })).not.toBeInTheDocument()
  })

  it("accepts a pasted key and refuses one that does not parse or is listed", async () => {
    const onSave = setup({ value: [grant(CHAT)] })
    const input = screen.getByLabelText("Search, or paste a conversation key")
    fireEvent.change(input, { target: { value: "not a key" } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("That is not a conversation key")
    fireEvent.change(input, { target: { value: "lark:bot-a:oc_1" } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Already on the list.")
    fireEvent.change(input, { target: { value: "lark:bot-a:oc_2" } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0][1].recipient).toEqual(conversationTarget("lark:bot-a:oc_2"))
    await waitFor(() => expect(input).toHaveValue(""))
  })

  it("keeps the text when the save is refused", async () => {
    const refused = jest.fn(async (_next: OutboundRecipientGrant[]) => false)
    setup({ onSave: refused })
    const input = screen.getByLabelText("Search, or paste a conversation key")
    fireEvent.change(input, { target: { value: "lark:bot-a:oc_2" } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() => expect(refused).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole("button", { name: "Add" })).not.toBeDisabled())
    expect(input).toHaveValue("lark:bot-a:oc_2")
  })

  it("normalizes an email address", async () => {
    const onSave = setup()
    fireEvent.click(screen.getByRole("button", { name: "Email" }))
    const input = screen.getByLabelText("name@example.com")
    fireEvent.change(input, { target: { value: "nope" } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("That is not an email address.")
    fireEvent.change(input, { target: { value: "Ops <OPS@Example.com>" } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0][0].recipient.recipient).toBe("mail:ops@example.com")
  })

  it("keeps a bot account's list to that account", async () => {
    const onSave = setup({ kinds: ["conversation", "person"], adapterId: "bot-a" })
    // Another account's chat is neither offered nor accepted.
    expect(screen.queryByRole("button", { name: "Add Other bot's chat" })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Search, or paste a conversation key"), {
      target: { value: "lark:bot-b:oc_9" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That conversation goes through another bot account."
    )
    // A member is named within the account.
    fireEvent.click(screen.getByRole("button", { name: "Person" }))
    fireEvent.change(screen.getByLabelText("Member id"), { target: { value: "ou_1" } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0][0].recipient).toEqual(personTarget("bot-a", "ou_1"))
  })

  it("says when no chat of the account is known", () => {
    setup({ knownConversations: [] })
    expect(screen.getByText(/has reached this device yet/)).toBeInTheDocument()
  })

  it("edits nothing while disabled", () => {
    setup({ value: [grant(CHAT)], disabled: true })
    expect(screen.getByRole("button", { name: "Remove Team chat" })).toBeDisabled()
    expect(screen.getByLabelText("Search, or paste a conversation key")).toBeDisabled()
  })
})

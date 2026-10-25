/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

const saveOutboundRecipients = jest.fn(async (_id: string, _next: unknown) => true)
let readiness = { availability: { state: "available", reason: "local-host" }, can: true }
let pending: ReadonlySet<string> = new Set()

jest.mock("@/hooks/bots/use-bot-lifecycle-actions", () => ({
  useBotLifecycleReadiness: () => readiness,
  useBotLifecycleActions: () => ({
    pending,
    saveOutboundRecipients: (id: string, next: unknown) => saveOutboundRecipients(id, next),
  }),
}))
jest.mock("@/hooks/outbound/use-known-conversations", () => ({
  useKnownConversations: () => [],
}))

import { BotOutboundRecipientsSection } from "./outbound-recipients-section"

function row(over: Partial<BotConsoleRow> = {}): BotConsoleRow {
  return { id: "boti_1", ...over } as BotConsoleRow
}

beforeEach(() => {
  readiness = { availability: { state: "available", reason: "local-host" }, can: true }
  pending = new Set()
  saveOutboundRecipients.mockClear()
})

describe("BotOutboundRecipientsSection", () => {
  it("saves the installation's list through the lifecycle write", async () => {
    render(<BotOutboundRecipientsSection row={row()} />)
    fireEvent.click(screen.getByRole("button", { name: "Email" }))
    fireEvent.change(screen.getByLabelText("name@example.com"), {
      target: { value: "ops@example.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() => expect(saveOutboundRecipients).toHaveBeenCalledTimes(1))
    expect(saveOutboundRecipients.mock.calls[0][0]).toBe("boti_1")
    // Members are named within a bot account, so a Bot's list does not offer them.
    expect(screen.queryByRole("button", { name: "Person" })).not.toBeInTheDocument()
  })

  it("is read-only where the write cannot land, saying why", () => {
    readiness = { availability: { state: "unsupported", reason: "requires-companion" }, can: false }
    render(<BotOutboundRecipientsSection row={row()} />)
    expect(screen.getByLabelText("Search, or paste a conversation key")).toBeDisabled()
  })

  it("is read-only for a Bot a paired host runs, and while a save is in flight", () => {
    const { unmount } = render(
      <BotOutboundRecipientsSection row={row({ owner: { kind: "remote-host" } as never })} />
    )
    expect(screen.getByLabelText("Search, or paste a conversation key")).toBeDisabled()
    unmount()
    pending = new Set(["recipients:boti_1"])
    render(<BotOutboundRecipientsSection row={row()} />)
    expect(screen.getByLabelText("Search, or paste a conversation key")).toBeDisabled()
  })
})

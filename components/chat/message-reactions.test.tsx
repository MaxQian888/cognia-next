import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { UIMessage } from "ai"

const toggleMessageReaction = jest.fn(async () => ({ reactions: [], added: true, mirror: "done" }))
jest.mock("@/lib/chat/reactions", () => ({
  ...jest.requireActual("@/lib/chat/reactions"),
  toggleMessageReaction: (...args: unknown[]) => toggleMessageReaction(...(args as [])),
}))

let route = "local"
jest.mock("@/lib/connectors/inbox-writes/use-inbox-write-route", () => ({
  useInboxWriteRoute: () => route,
}))

const toastWarning = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    warning: (...args: unknown[]) => toastWarning(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `t:${key}:${JSON.stringify(values)}` : `t:${key}`,
}))

import { MessageReactionAdd, MessageReactionPills } from "./message-reactions"

function message(reactions?: unknown): UIMessage {
  return {
    id: "m1",
    role: "assistant",
    parts: [{ type: "text", text: "hi" }],
    metadata: reactions ? { reactions } : {},
  } as unknown as UIMessage
}

/** A row that arrived over an IM connector — the multi-party case. */
function imMessage(reactions?: unknown): UIMessage {
  return {
    id: "m2",
    role: "user",
    parts: [{ type: "text", text: "hi" }],
    metadata: {
      platformMessage: { messageId: "p1", adapterId: "telegram", platform: "telegram" },
      ...(reactions ? { reactions } : {}),
    },
  } as unknown as UIMessage
}

beforeEach(() => {
  route = "local"
  toggleMessageReaction.mockClear()
  toastWarning.mockClear()
  toastError.mockClear()
})

it("renders each reaction as a pill with its count and marks the local user's own", () => {
  render(
    <MessageReactionPills
      message={message([
        { emoji: "👍", actorIds: ["local", "telegram:u2"] },
        { emoji: "❤️", actorIds: ["telegram:u2"] },
      ])}
      sessionId="s1"
    />
  )
  const thumbs = screen.getByTestId("message-reaction-👍")
  expect(thumbs).toHaveTextContent("2")
  expect(thumbs).toHaveAttribute("aria-pressed", "true")
  expect(screen.getByTestId("message-reaction-❤️")).toHaveAttribute("aria-pressed", "false")
})

it("renders no pill row without reactions, so the action line keeps its shape", () => {
  const { container } = render(<MessageReactionPills message={message()} sessionId="s1" />)
  expect(container).toBeEmptyDOMElement()
})

it("toggles through a pill and through the picker", async () => {
  render(
    <>
      <MessageReactionPills message={message([{ emoji: "👍", actorIds: ["x"] }])} sessionId="s1" />
      <MessageReactionAdd message={imMessage([{ emoji: "👍", actorIds: ["x"] }])} sessionId="s1" />
    </>
  )
  fireEvent.click(screen.getByTestId("message-reaction-👍"))
  await waitFor(() => expect(toggleMessageReaction).toHaveBeenCalledTimes(1))
  expect(toggleMessageReaction).toHaveBeenLastCalledWith(
    expect.objectContaining({ sessionId: "s1", emoji: "👍" })
  )
  fireEvent.click(screen.getByTestId("message-reaction-add"))
  fireEvent.click(await screen.findByTestId("message-reaction-pick-🎉"))
  await waitFor(() => expect(toggleMessageReaction).toHaveBeenCalledTimes(2))
  expect(toggleMessageReaction).toHaveBeenLastCalledWith(expect.objectContaining({ emoji: "🎉" }))
})

it("warns when the platform did not take the reaction, and errors when the write failed", async () => {
  toggleMessageReaction.mockResolvedValueOnce({
    reactions: [],
    added: true,
    mirror: { failed: "adapter cannot add reactions" },
  } as never)
  render(
    <MessageReactionPills message={message([{ emoji: "👍", actorIds: ["x"] }])} sessionId="s1" />
  )
  fireEvent.click(screen.getByTestId("message-reaction-👍"))
  await waitFor(() =>
    expect(toastWarning).toHaveBeenCalledWith("t:mirrorFailed", expect.anything())
  )
  toggleMessageReaction.mockRejectedValueOnce(new Error("boom"))
  fireEvent.click(screen.getByTestId("message-reaction-👍"))
  await waitFor(() => expect(toastError).toHaveBeenCalledWith("boom"))
})

it("shows the pills read-only with the reason on a companion shell", () => {
  route = "remote"
  render(
    <>
      <MessageReactionPills message={message([{ emoji: "👍", actorIds: ["x"] }])} sessionId="s1" />
      <MessageReactionAdd message={imMessage()} sessionId="s1" />
    </>
  )
  expect(screen.getByTestId("message-reactions")).toHaveAttribute("data-ability", "host-only")
  const pill = screen.getByTestId("message-reaction-👍")
  expect(pill).toBeDisabled()
  expect(pill).toHaveAttribute("title", "t:needsHost")
  expect(screen.getByTestId("message-reaction-add")).toBeDisabled()
})

it("offers no add button without a conversation to write into", () => {
  const { container } = render(<MessageReactionAdd message={imMessage()} />)
  expect(container).toBeEmptyDOMElement()
})

it("offers no add button on a solo assistant row, where a reaction reaches nobody", () => {
  const { container } = render(<MessageReactionAdd message={message()} sessionId="s1" />)
  expect(container).toBeEmptyDOMElement()
})

it("offers the add button once the row already carries a reaction somebody left", () => {
  render(
    <MessageReactionAdd message={message([{ emoji: "👍", actorIds: ["x"] }])} sessionId="s1" />
  )
  expect(screen.getByTestId("message-reaction-add")).toBeInTheDocument()
})

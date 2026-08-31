/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))
jest.mock("@/components/inbox/platform-badge", () => ({
  PlatformBadge: ({ platform }: { platform: string }) => (
    <span data-testid="platform-badge" data-platform={platform} />
  ),
}))

const mockListBindings = jest.fn(async (_runId: string): Promise<unknown[]> => [])
jest.mock("@/lib/db/execution-runs", () => ({
  listExecutionRunBindings: (runId: string) => mockListBindings(runId),
}))

import { RunImOrigin } from "./run-im-origin"

beforeEach(() => mockListBindings.mockReset().mockResolvedValue([]))

// Every run started on the desktop has no binding. Absence has to read as
// "not from a chat", never as a broken row.
it("renders nothing for a run that did not come from a chat", async () => {
  const { container } = render(<RunImOrigin runId="run_1" />)
  await waitFor(() => expect(mockListBindings).toHaveBeenCalledWith("run_1"))
  expect(container).toBeEmptyDOMElement()
})

it("renders nothing without a run id", () => {
  const { container } = render(<RunImOrigin runId={undefined} />)
  expect(container).toBeEmptyDOMElement()
  expect(mockListBindings).not.toHaveBeenCalled()
})

it("links to the conversation the run came from", async () => {
  mockListBindings.mockResolvedValue([{ conversationKey: "telegram:tg-1:9", status: "active" }])
  render(<RunImOrigin runId="run_1" />)
  const link = await screen.findByTestId("run-im-origin")
  expect(link).toHaveAttribute("href", "/inbox/c?key=telegram%3Atg-1%3A9")
  expect(screen.getByTestId("platform-badge")).toHaveAttribute("data-platform", "telegram")
})

// Without the message id the link lands at the bottom of a thread that may be
// hundreds of messages past the request being asked about.
it("lands on the message that started the run when the binding recorded one", async () => {
  mockListBindings.mockResolvedValue([
    { conversationKey: "telegram:tg-1:9", sourceMessageId: "m_42" },
  ])
  render(<RunImOrigin runId="run_1" />)
  expect(await screen.findByTestId("run-im-origin")).toHaveAttribute(
    "href",
    "/inbox/c?key=telegram%3Atg-1%3A9&messageId=m_42"
  )
})

it("still links to the conversation when no source message was recorded", async () => {
  mockListBindings.mockResolvedValue([{ conversationKey: "telegram:tg-1:9" }])
  render(<RunImOrigin runId="run_1" />)
  const href = (await screen.findByTestId("run-im-origin")).getAttribute("href")
  expect(href).toBe("/inbox/c?key=telegram%3Atg-1%3A9")
})

// A corrupt key is not a reason to claim the run has no origin at all.
it("skips an unparseable binding and keeps looking", async () => {
  mockListBindings.mockResolvedValue([
    { conversationKey: "garbage" },
    { conversationKey: "slack:sl-1:C1" },
  ])
  render(<RunImOrigin runId="run_1" />)
  const link = await screen.findByTestId("run-im-origin")
  expect(link).toHaveAttribute("data-conversation-key", "slack:sl-1:C1")
})

it("ignores a binding with no conversation key", async () => {
  mockListBindings.mockResolvedValue([{ status: "active" }, { conversationKey: "discord:dc:1" }])
  render(<RunImOrigin runId="run_1" />)
  await waitFor(() =>
    expect(screen.getByTestId("run-im-origin")).toHaveAttribute(
      "data-conversation-key",
      "discord:dc:1"
    )
  )
})

// A rejecting read must not take the whole detail pane down with it.
it("renders nothing when the lookup rejects", async () => {
  mockListBindings.mockRejectedValue(new Error("dexie down"))
  const { container } = render(<RunImOrigin runId="run_1" />)
  await waitFor(() => expect(mockListBindings).toHaveBeenCalled())
  expect(container).toBeEmptyDOMElement()
})

/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const loadBacklinksMock = jest.fn()
jest.mock("@/lib/chat/mentions/backlinks", () => {
  const actual = jest.requireActual("@/lib/chat/mentions/backlinks")
  return {
    ...actual,
    loadBacklinks: (...args: unknown[]) => loadBacklinksMock(...args),
  }
})

const jumpMock = jest.fn()
jest.mock("@/lib/chat/cross-session-jump", () => ({
  jumpToSessionMessage: (...args: unknown[]) => jumpMock(...args),
}))

import { MentionBacklinksChip, MentionBacklinksPanel } from "./mention-backlinks-chip"
import { entityBacklinkTarget } from "@/lib/chat/mentions/backlinks"

const target = entityBacklinkTarget("memory", "mem_1")

const group = (over = {}) => ({
  sessionId: "s1",
  sessionTitle: "Indexing work",
  messageId: "m1",
  createdAt: 1_000,
  count: 1,
  ...over,
})

beforeEach(() => {
  loadBacklinksMock.mockReset().mockResolvedValue({ groups: [], total: 0 })
  jumpMock.mockReset()
})

describe("MentionBacklinksChip", () => {
  // A provenance chip that costs nothing when there is nothing to say — the
  // rule the whole chat-header chip family follows.
  it("renders nothing for a record nothing has referenced", async () => {
    const { container } = render(<MentionBacklinksChip target={target} />)
    await waitFor(() => expect(loadBacklinksMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it("counts the conversations, not the turns", async () => {
    loadBacklinksMock.mockResolvedValue({
      groups: [group(), group({ sessionId: "s2", count: 4 })],
      total: 5,
    })
    render(<MentionBacklinksChip target={target} />)
    const chip = await screen.findByTestId("mention-backlinks-chip")
    expect(chip.textContent).toContain('"count":2')
  })

  it("passes the excluded conversation through to the read", async () => {
    render(<MentionBacklinksChip target={target} excludeSessionId="s1" />)
    await waitFor(() =>
      expect(loadBacklinksMock).toHaveBeenCalledWith(
        { refKind: "entity", refId: "memory:mem_1" },
        { excludeSessionId: "s1" }
      )
    )
  })

  // It is an extra; failing loudly would be worse than not showing it.
  it("stays silent when the index cannot be read", async () => {
    loadBacklinksMock.mockRejectedValue(new Error("db closed"))
    const { container } = render(<MentionBacklinksChip target={target} />)
    await waitFor(() => expect(loadBacklinksMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })
})

describe("MentionBacklinksPanel", () => {
  it("renders nothing when there are no backlinks", async () => {
    const { container } = render(<MentionBacklinksPanel target={target} />)
    await waitFor(() => expect(loadBacklinksMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it("lists each citing conversation", async () => {
    loadBacklinksMock.mockResolvedValue({
      groups: [group(), group({ sessionId: "s2", sessionTitle: "Other chat" })],
      total: 2,
    })
    render(<MentionBacklinksPanel target={target} />)
    await waitFor(() => expect(screen.getAllByTestId("mention-backlink-row")).toHaveLength(2))
    expect(screen.getByText("Indexing work")).toBeInTheDocument()
  })

  it("says how many turns in a conversation cited it, when more than one did", async () => {
    loadBacklinksMock.mockResolvedValue({ groups: [group({ count: 3 })], total: 3 })
    render(<MentionBacklinksPanel target={target} />)
    const row = await screen.findByTestId("mention-backlink-row")
    expect(row.textContent).toContain('"count":3')
  })

  it("says nothing extra for a conversation that cited it once", async () => {
    loadBacklinksMock.mockResolvedValue({ groups: [group({ count: 1 })], total: 1 })
    render(<MentionBacklinksPanel target={target} />)
    const row = await screen.findByTestId("mention-backlink-row")
    expect(row.textContent).not.toContain("timesInConversation")
  })

  // The point of the list is to show what someone said about it — not to drop
  // you at the conversation's tail.
  it("lands on the exact citing turn", async () => {
    loadBacklinksMock.mockResolvedValue({ groups: [group()], total: 1 })
    render(<MentionBacklinksPanel target={target} />)
    fireEvent.click(await screen.findByTestId("mention-backlink-row"))
    expect(jumpMock).toHaveBeenCalledWith("s1", "m1")
  })

  it("re-reads when the target changes", async () => {
    const { rerender } = render(<MentionBacklinksPanel target={target} />)
    await waitFor(() => expect(loadBacklinksMock).toHaveBeenCalledTimes(1))
    rerender(<MentionBacklinksPanel target={entityBacklinkTarget("issue", "iss_1")} />)
    await waitFor(() => expect(loadBacklinksMock).toHaveBeenCalledTimes(2))
  })
})

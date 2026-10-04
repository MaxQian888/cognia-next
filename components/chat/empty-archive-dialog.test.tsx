/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${ns}.${key}:${JSON.stringify(values)}` : `${ns}.${key}`,
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

const deleteRouted = jest.fn()
jest.mock("@/lib/chat/session-archive-writes", () => ({
  deleteSessionsRouted: (ids: readonly string[]) => deleteRouted(ids),
}))

jest.mock("@/lib/telemetry/conversation-list-events", () => ({
  trackConversationRowAction: jest.fn(() => Promise.resolve(true)),
}))

import { EmptyArchiveDialog } from "./empty-archive-dialog"

const LOCK = { ticketId: "tk", lockedAt: 1 } as unknown as ChatSession["handoffLock"]

const row = (id: string, over: Partial<ChatSession> = {}): ChatSession =>
  ({
    id,
    title: `T-${id}`,
    kind: "direct",
    createdAt: 1,
    updatedAt: 1,
    archivedAt: 9,
    ...over,
  }) as ChatSession

beforeEach(() => {
  deleteRouted.mockReset().mockResolvedValue(undefined)
  toastSuccess.mockReset()
  toastError.mockReset()
})

describe("EmptyArchiveDialog", () => {
  it("names the count and titles, and deletes every archived row", async () => {
    const onOpenChange = jest.fn()
    const onEmptied = jest.fn()
    const rows = Array.from({ length: 7 }, (_, index) => row(`a${index}`))
    render(
      <EmptyArchiveDialog
        open
        onOpenChange={onOpenChange}
        onEmptied={onEmptied}
        sessions={[...rows, row("active", { archivedAt: undefined })]}
        scopeLabel="Workspace A"
      />
    )
    expect(screen.getByText('conversations.archive.empty.title:{"count":7}')).toBeInTheDocument()
    expect(screen.getByText(/conversations.archive.empty.scope/)).toHaveTextContent("Workspace A")
    const titles = screen.getByTestId("empty-archive-titles")
    expect(titles).toHaveTextContent("T-a0")
    expect(titles).not.toHaveTextContent("T-a5")
    expect(titles).toHaveTextContent('conversations.archive.empty.more:{"count":2}')
    await act(async () => {
      fireEvent.click(screen.getByTestId("empty-archive-confirm"))
    })
    expect(deleteRouted).toHaveBeenCalledWith(rows.map((r) => r.id))
    expect(toastSuccess.mock.calls[0]![0]).toBe('conversations.archive.empty.success:{"count":7}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onEmptied).toHaveBeenCalled()
  })

  it("keeps handed-off conversations out of the delete and says so", async () => {
    render(
      <EmptyArchiveDialog
        open
        onOpenChange={jest.fn()}
        sessions={[row("a"), row("locked", { handoffLock: LOCK })]}
      />
    )
    expect(screen.getByTestId("empty-archive-locked-note")).toHaveTextContent(
      'conversations.archive.empty.lockedKept:{"count":1}'
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId("empty-archive-confirm"))
    })
    expect(deleteRouted).toHaveBeenCalledWith(["a"])
  })

  it("stays open and says why when the delete fails", async () => {
    deleteRouted.mockRejectedValue(new Error("disk full"))
    const onOpenChange = jest.fn()
    render(<EmptyArchiveDialog open onOpenChange={onOpenChange} sessions={[row("a")]} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("empty-archive-confirm"))
    })
    expect(toastError).toHaveBeenCalledWith("chat.sessionWrite.actionFailed.delete", {
      description: "disk full",
    })
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("offers nothing to confirm when the archive is already empty", () => {
    render(<EmptyArchiveDialog open onOpenChange={jest.fn()} sessions={[]} />)
    expect(screen.getByText("conversations.archive.empty.nothingTitle")).toBeInTheDocument()
    expect(screen.queryByTestId("empty-archive-confirm")).toBeNull()
  })
})

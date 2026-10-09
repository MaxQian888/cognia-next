/** @jest-environment jsdom */

// Unfinished "Build with AI" drafts (ADR-0220): one row per draft that
// resumes it, and a discard button that asks first and then deletes the
// builder conversation.

import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
const mockToastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}))
jest.mock("@/lib/agents/builder/builder-session", () => ({ listBuilderDrafts: jest.fn() }))
jest.mock("@/lib/chat/session-archive-writes", () => ({
  deleteSessionsRouted: jest.fn(() => Promise.resolve()),
}))

import { useLiveQuery } from "dexie-react-hooks"
import { listBuilderDrafts } from "@/lib/agents/builder/builder-session"
import { deleteSessionsRouted } from "@/lib/chat/session-archive-writes"
import { AgentBuilderDrafts } from "./agent-builder-drafts"

const useLiveQueryMock = useLiveQuery as jest.Mock
const listBuilderDraftsMock = listBuilderDrafts as jest.Mock
const deleteMock = deleteSessionsRouted as jest.Mock

let mockDrafts: ChatSession[] | undefined

function draftSession(
  id: string,
  over: { name?: string; updatedAt?: number; builderUpdatedAt?: number; emoji?: string } = {}
): ChatSession {
  return {
    id,
    title: "Agent Builder",
    kind: "agent-builder",
    updatedAt: over.updatedAt ?? Date.UTC(2026, 0, 1),
    agentBuilder:
      over.builderUpdatedAt === undefined && over.name === undefined && over.emoji === undefined
        ? undefined
        : {
            draft: { name: over.name, avatarEmoji: over.emoji },
            revision: 1,
            editedBy: "agent",
            status: "drafting",
            updatedAt: over.builderUpdatedAt ?? Date.UTC(2026, 0, 5),
          },
  } as unknown as ChatSession
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDrafts = undefined
  useLiveQueryMock.mockImplementation(() => mockDrafts)
  listBuilderDraftsMock.mockResolvedValue([])
})

describe("AgentBuilderDrafts", () => {
  it("reads the drafts through a live query", async () => {
    render(<AgentBuilderDrafts onResume={jest.fn()} />)
    const querier = useLiveQueryMock.mock.calls[0]![0] as () => Promise<unknown>
    expect(useLiveQueryMock.mock.calls[0]![1]).toEqual([])
    await querier()
    expect(listBuilderDraftsMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["still loading", undefined],
    ["empty", []],
  ])("renders nothing while the list is %s", (_n, drafts) => {
    mockDrafts = drafts
    const { container } = render(<AgentBuilderDrafts onResume={jest.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("lists each draft by name with when it was edited", () => {
    mockDrafts = [
      draftSession("s1", {
        name: "  Reviewer  ",
        builderUpdatedAt: Date.UTC(2026, 0, 5),
        emoji: "🦊",
      }),
      draftSession("s2", { name: "   " }),
      draftSession("s3", { updatedAt: Date.UTC(2026, 0, 3) }),
    ]
    render(<AgentBuilderDrafts onResume={jest.fn()} className="mt-6" />)
    const section = screen.getByTestId("agent-builder-drafts")
    expect(section).toHaveClass("mt-6")
    expect(section).toHaveAccessibleName("Unfinished drafts (3)")
    const rows = screen.getAllByTestId("agent-builder-draft")
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent("Reviewer")
    expect(rows[0]).toHaveTextContent("Edited 2026-01-05T00:00:00.000Z")
    expect(rows[0]).toHaveTextContent("Resume")
    expect(rows[0]).toHaveTextContent("🦊")
    expect(rows[1]).toHaveTextContent("Untitled draft")
    // No builder state: the session's own update time is used.
    expect(rows[2]).toHaveTextContent("Untitled draft")
    expect(rows[2]).toHaveTextContent("Edited 2026-01-03T00:00:00.000Z")
  })

  it("titles a single draft in the singular", () => {
    mockDrafts = [draftSession("s1", { name: "Solo" })]
    render(<AgentBuilderDrafts onResume={jest.fn()} />)
    // The jest next-intl stub resolves only `=N` / `other` plural branches.
    expect(screen.getByTestId("agent-builder-drafts")).toHaveAccessibleName(/Unfinished draft/)
    expect(screen.getAllByTestId("agent-builder-draft")).toHaveLength(1)
  })

  it("resumes a draft from its row", async () => {
    const user = userEvent.setup()
    const onResume = jest.fn()
    mockDrafts = [draftSession("s1", { name: "Reviewer" }), draftSession("s2", { name: "Writer" })]
    render(<AgentBuilderDrafts onResume={onResume} />)
    await user.click(screen.getByRole("button", { name: "Resume draft Writer" }))
    expect(onResume).toHaveBeenCalledWith("s2")
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it("asks before discarding, then deletes the draft's conversation", async () => {
    const user = userEvent.setup()
    const onResume = jest.fn()
    mockDrafts = [draftSession("s1", { name: "Reviewer" }), draftSession("s2", { name: "Writer" })]
    render(<AgentBuilderDrafts onResume={onResume} />)
    await user.click(screen.getByRole("button", { name: "Discard draft Reviewer" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText("Discard this draft?")).toBeInTheDocument()
    expect(within(dialog).getByText(/its builder conversation will be deleted/)).toBeInTheDocument()
    expect(deleteMock).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole("button", { name: "Discard" }))
    expect(deleteMock).toHaveBeenCalledWith(["s1"])
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(onResume).not.toHaveBeenCalled()
  })

  it("says so when the discard fails", async () => {
    const user = userEvent.setup()
    deleteMock.mockRejectedValueOnce(new Error("locked"))
    mockDrafts = [draftSession("s1", { name: "Reviewer" })]
    render(<AgentBuilderDrafts onResume={jest.fn()} />)
    await user.click(screen.getByRole("button", { name: "Discard draft Reviewer" }))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Discard" }))
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Couldn't discard the draft: locked")
    )
  })

  it("keeps the draft when the discard is cancelled", async () => {
    const user = userEvent.setup()
    mockDrafts = [draftSession("s1", { name: "Reviewer" })]
    render(<AgentBuilderDrafts onResume={jest.fn()} />)
    await user.click(screen.getByRole("button", { name: "Discard draft Reviewer" }))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it("names an untitled draft in its discard and resume labels", () => {
    mockDrafts = [draftSession("s1")]
    render(<AgentBuilderDrafts onResume={jest.fn()} />)
    expect(screen.getByRole("button", { name: "Resume draft Untitled draft" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Discard draft Untitled draft" })).toBeInTheDocument()
  })
})

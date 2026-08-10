/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TwinDraftsPanel } from "./twin-drafts-panel"
import type { TwinDraft } from "@/types/twin"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

jest.mock("motion/react", () => ({
  motion: {
    ul: ({ children }: { children: React.ReactNode }) => <ul>{children}</ul>,
    li: ({ children }: { children: React.ReactNode }) => <li>{children}</li>,
  },
  useReducedMotion: () => true,
}))

// Reduce the swipe row to its children plus a button per action so the
// accept / reject handlers are directly clickable in jsdom.
jest.mock("@/components/interactions/swipe-row", () => ({
  SwipeRow: ({
    children,
    leftActions = [],
    rightActions = [],
  }: {
    children: React.ReactNode
    leftActions?: { id: string; label: string; onSelect: () => void }[]
    rightActions?: { id: string; label: string; onSelect: () => void }[]
  }) => (
    <div>
      {children}
      {[...leftActions, ...rightActions].map((a) => (
        <button key={a.id} data-testid={`action-${a.id}`} onClick={a.onSelect}>
          {a.label}
        </button>
      ))}
    </div>
  ),
}))

jest.mock("./twin-draft-card", () => ({
  TwinDraftCard: ({ draft }: { draft: TwinDraft }) => (
    <div data-testid={`draft-${draft.id}`}>{draft.id}</div>
  ),
}))

jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/db/twin-drafts", () => ({
  listTwinDraftsByTwinAndStatus: jest.fn(),
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

const mockRuntimeSnapshot = {
  target: null as null | { id: string; kind: "companion" },
  host: undefined as undefined | { operations: string[] },
}
jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => mockRuntimeSnapshot,
}))

import { useLiveQuery } from "dexie-react-hooks"
import { enqueue } from "@/lib/db/mobile-outbound-queue"

const useLiveQueryMock = useLiveQuery as jest.Mock
const enqueueMock = enqueue as jest.Mock

const mkDraft = (p: Partial<TwinDraft> = {}): TwinDraft =>
  ({
    id: "d1",
    twinId: "default",
    jobId: "j1",
    kind: "character",
    payload: { data: { name: "Persona", description: "d" } },
    provenance: {},
    status: "pending",
    createdAt: 1,
    ...p,
  }) as unknown as TwinDraft

beforeEach(() => {
  useLiveQueryMock.mockReset()
  enqueueMock.mockClear()
  mockRuntimeSnapshot.target = null
  mockRuntimeSnapshot.host = undefined
})

describe("TwinDraftsPanel", () => {
  it("renders the panel container with no cards when empty", () => {
    useLiveQueryMock.mockReturnValue([])
    render(<TwinDraftsPanel twinId="twin-1" />)
    expect(screen.getByTestId("twin-drafts-panel")).toBeInTheDocument()
    expect(screen.queryByTestId(/^draft-/)).not.toBeInTheDocument()
  })

  it("renders a card per pending draft", () => {
    useLiveQueryMock.mockReturnValue([mkDraft({ id: "d1" }), mkDraft({ id: "d2" })])
    render(<TwinDraftsPanel twinId="twin-1" />)
    expect(screen.getByTestId("draft-d1")).toBeInTheDocument()
    expect(screen.getByTestId("draft-d2")).toBeInTheDocument()
  })

  it("queues a desktop-owned character draft acceptance", async () => {
    useLiveQueryMock.mockReturnValue([mkDraft({ id: "d1", kind: "character" })])
    const user = userEvent.setup()
    render(<TwinDraftsPanel twinId="twin-1" />)
    await user.click(screen.getByTestId("action-accept"))
    await waitFor(() =>
      expect(enqueueMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "twin_draft_review",
          payload: { twinId: "twin-1", draftId: "d1", action: "accept" },
        })
      )
    )
  })

  it("queues a desktop-owned draft rejection", async () => {
    useLiveQueryMock.mockReturnValue([mkDraft({ id: "d1" })])
    const user = userEvent.setup()
    render(<TwinDraftsPanel twinId="twin-1" />)
    await user.click(screen.getByTestId("action-reject"))
    await waitFor(() =>
      expect(enqueueMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "twin_draft_review",
          payload: { twinId: "twin-1", draftId: "d1", action: "reject" },
        })
      )
    )
  })

  it("disables review and prompts for an upgrade on an older Host", () => {
    mockRuntimeSnapshot.target = { id: "old-host", kind: "companion" }
    mockRuntimeSnapshot.host = { operations: ["twin_ingest_source"] }
    useLiveQueryMock.mockReturnValue([mkDraft({ id: "d1" })])

    render(<TwinDraftsPanel twinId="twin-1" />)

    expect(screen.getByRole("alert")).toHaveTextContent("upgradeRequired")
    expect(screen.queryByTestId("action-accept")).not.toBeInTheDocument()
    expect(screen.queryByTestId("action-reject")).not.toBeInTheDocument()
    expect(enqueueMock).not.toHaveBeenCalled()
  })
})

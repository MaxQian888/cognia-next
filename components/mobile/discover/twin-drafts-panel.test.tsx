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

jest.mock("@/lib/db/characters", () => ({
  createCharacter: jest.fn().mockResolvedValue({ id: "new-char" }),
}))
jest.mock("@/lib/db/skills", () => ({
  createSkill: jest.fn().mockResolvedValue({ id: "new-skill" }),
}))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/db/twin-drafts", () => ({
  listTwinDraftsByTwinAndStatus: jest.fn(),
  markTwinDraftAccepted: jest.fn().mockResolvedValue(undefined),
  markTwinDraftRejected: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ twinDrafts: { where: jest.fn() } }),
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

import { useLiveQuery } from "dexie-react-hooks"
import { createCharacter } from "@/lib/db/characters"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { markTwinDraftAccepted, markTwinDraftRejected } from "@/lib/db/twin-drafts"

const useLiveQueryMock = useLiveQuery as jest.Mock
const createCharacterMock = createCharacter as jest.Mock
const enqueueMock = enqueue as jest.Mock
const markAcceptedMock = markTwinDraftAccepted as jest.Mock
const markRejectedMock = markTwinDraftRejected as jest.Mock

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
  createCharacterMock.mockClear()
  enqueueMock.mockClear()
  markAcceptedMock.mockClear()
  markRejectedMock.mockClear()
})

describe("TwinDraftsPanel", () => {
  it("renders the panel container with no cards when empty", () => {
    useLiveQueryMock.mockReturnValue([])
    render(<TwinDraftsPanel />)
    expect(screen.getByTestId("twin-drafts-panel")).toBeInTheDocument()
    expect(screen.queryByTestId(/^draft-/)).not.toBeInTheDocument()
  })

  it("renders a card per pending draft", () => {
    useLiveQueryMock.mockReturnValue([mkDraft({ id: "d1" }), mkDraft({ id: "d2" })])
    render(<TwinDraftsPanel />)
    expect(screen.getByTestId("draft-d1")).toBeInTheDocument()
    expect(screen.getByTestId("draft-d2")).toBeInTheDocument()
  })

  it("accepts a character draft: persists it, marks accepted, enqueues a mirror", async () => {
    useLiveQueryMock.mockReturnValue([mkDraft({ id: "d1", kind: "character" })])
    const user = userEvent.setup()
    render(<TwinDraftsPanel />)
    await user.click(screen.getByTestId("action-accept"))
    await waitFor(() => expect(createCharacterMock).toHaveBeenCalled())
    expect(markAcceptedMock).toHaveBeenCalledWith("d1", "new-char")
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "twin_ingest_source",
        payload: expect.objectContaining({ kind: "twin_draft_accept", draftId: "d1" }),
      })
    )
  })

  it("rejects a draft: marks rejected and enqueues a mirror", async () => {
    useLiveQueryMock.mockReturnValue([mkDraft({ id: "d1" })])
    const user = userEvent.setup()
    render(<TwinDraftsPanel />)
    await user.click(screen.getByTestId("action-reject"))
    await waitFor(() => expect(markRejectedMock).toHaveBeenCalledWith("d1"))
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ kind: "twin_draft_reject", draftId: "d1" }),
      })
    )
  })
})

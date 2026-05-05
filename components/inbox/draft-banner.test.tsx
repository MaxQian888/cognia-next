/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

jest.mock("@/lib/db/outbound-jobs", () => ({
  enqueueOutbound: jest.fn().mockResolvedValue({ id: "oqj_1" }),
}))

jest.mock("@/lib/db/connector-drafts", () => ({
  approveDraft: jest.fn().mockResolvedValue(undefined),
  rejectDraft: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="sheet">{children}</div> : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

let mockPendingDrafts: unknown[] = []

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn().mockImplementation(() => mockPendingDrafts),
}))

// ---------------------------------------------------------------------------
// Subject + imported mocks
// ---------------------------------------------------------------------------

import { DraftBanner } from "./draft-banner"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { approveDraft, rejectDraft } from "@/lib/db/connector-drafts"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import type { OutboundRequest } from "@/types/connectors/outbound"

const mockEnqueue = enqueueOutbound as jest.Mock
const mockApprove = approveDraft as jest.Mock
const mockReject = rejectDraft as jest.Mock

function makeDraft(overrides: Partial<ConnectorDraftRow> = {}): ConnectorDraftRow {
  return {
    id: "cdr_1",
    conversationKey: "ck1",
    sessionId: "s1",
    segments: [{ type: "text", text: "Hello platform user!" }],
    status: "pending",
    createdAt: Date.now(),
    outboundPreview: {
      conversationRef: { platform: "telegram", adapterId: "a1", chatId: 123 },
      segments: [{ type: "text", text: "Hello platform user!" }],
      metadata: { idempotencyKey: "idem_1" },
    } satisfies OutboundRequest,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DraftBanner", () => {
  beforeEach(() => {
    mockPendingDrafts = []
    mockEnqueue.mockReset().mockResolvedValue({ id: "oqj_1" })
    mockApprove.mockReset().mockResolvedValue(undefined)
    mockReject.mockReset().mockResolvedValue(undefined)
  })

  it("renders nothing when no pending drafts exist", () => {
    mockPendingDrafts = []
    const { container } = render(<DraftBanner conversationKey="ck1" />)
    expect(container.firstChild).toBeNull()
  })

  it("shows banner when a pending draft exists", () => {
    mockPendingDrafts = [makeDraft()]
    render(<DraftBanner conversationKey="ck1" />)
    expect(screen.getByTestId("draft-banner")).toBeInTheDocument()
    expect(screen.getByTestId("draft-review-btn")).toBeInTheDocument()
  })

  it("opens sheet on Review click", () => {
    mockPendingDrafts = [makeDraft()]
    render(<DraftBanner conversationKey="ck1" />)
    fireEvent.click(screen.getByTestId("draft-review-btn"))
    expect(screen.getByTestId("sheet")).toBeInTheDocument()
    expect(screen.getByTestId("draft-editor")).toBeInTheDocument()
  })

  it("Approve & Send enqueues outbound + marks draft approved", async () => {
    mockPendingDrafts = [makeDraft()]
    render(<DraftBanner conversationKey="ck1" />)
    fireEvent.click(screen.getByTestId("draft-review-btn"))

    fireEvent.click(screen.getByTestId("draft-approve-btn"))

    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ conversationKey: "ck1" }))
      expect(mockApprove).toHaveBeenCalledWith("cdr_1")
    })
  })

  it("Reject marks draft rejected", async () => {
    mockPendingDrafts = [makeDraft()]
    render(<DraftBanner conversationKey="ck1" />)
    fireEvent.click(screen.getByTestId("draft-review-btn"))

    fireEvent.click(screen.getByTestId("draft-reject-btn"))

    await waitFor(() => {
      expect(mockReject).toHaveBeenCalledWith("cdr_1")
    })
  })
})

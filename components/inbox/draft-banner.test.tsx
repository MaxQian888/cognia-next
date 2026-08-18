/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

// ADR-0131: `useDraftApproval` routes both actions through the inbox-write
// facade, so the notice no longer enqueues delivery itself.
jest.mock("@/lib/connectors/inbox-writes", () => ({
  approveInboxDraft: jest.fn().mockResolvedValue({ route: "local", draftId: "d1" }),
  rejectInboxDraft: jest.fn().mockResolvedValue({ route: "local", draftId: "d1" }),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const inboxWrites = require("@/lib/connectors/inbox-writes") as {
  approveInboxDraft: jest.Mock
  rejectInboxDraft: jest.Mock
}
const mockApproveInbox = inboxWrites.approveInboxDraft
const mockRejectInbox = inboxWrites.rejectInboxDraft

jest.mock("@/lib/db/outbound-jobs", () => ({
  enqueueOutbound: jest.fn().mockResolvedValue({ id: "oqj_1" }),
}))

jest.mock("@/lib/db/connector-drafts", () => ({
  approveDraft: jest.fn().mockResolvedValue(undefined),
  rejectDraft: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@/components/ui/sheet")

// `DraftEditor` still reaches for Dexie through this hook.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn().mockImplementation(() => []),
}))

// ---------------------------------------------------------------------------
// Subject + imported mocks
// ---------------------------------------------------------------------------

import { DraftNotice } from "./draft-banner"
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

// Draft selection ("is there a pending draft at all?") lives in
// `InboxNoticeArea` and is pinned by its suite. This component is handed the
// one draft to present.
describe("DraftNotice", () => {
  beforeEach(() => {
    mockEnqueue.mockReset().mockResolvedValue({ id: "oqj_1" })
    mockApprove.mockReset().mockResolvedValue(undefined)
    mockReject.mockReset().mockResolvedValue(undefined)
  })

  it("shows the pending-draft row and its review affordance", () => {
    render(<DraftNotice draft={makeDraft()} conversationKey="ck1" />)
    expect(screen.getByTestId("draft-banner")).toBeInTheDocument()
    expect(screen.getByTestId("draft-review-btn")).toBeInTheDocument()
  })

  it("keeps the editor sheet closed until Review is clicked", () => {
    render(<DraftNotice draft={makeDraft()} conversationKey="ck1" />)
    expect(screen.queryByTestId("draft-editor")).not.toBeInTheDocument()
  })

  it("opens sheet on Review click", () => {
    render(<DraftNotice draft={makeDraft()} conversationKey="ck1" />)
    fireEvent.click(screen.getByTestId("draft-review-btn"))
    expect(screen.getByTestId("sheet")).toBeInTheDocument()
    expect(screen.getByTestId("draft-editor")).toBeInTheDocument()
  })

  it("Approve & Send enqueues outbound + marks draft approved", async () => {
    render(<DraftNotice draft={makeDraft()} conversationKey="ck1" />)
    fireEvent.click(screen.getByTestId("draft-review-btn"))

    fireEvent.click(screen.getByTestId("draft-approve-btn"))

    await waitFor(() => {
      expect(mockApproveInbox).toHaveBeenCalledWith(
        expect.objectContaining({ id: "cdr_1" }),
        expect.anything()
      )
    })
  })

  it("Reject marks draft rejected", async () => {
    render(<DraftNotice draft={makeDraft()} conversationKey="ck1" />)
    fireEvent.click(screen.getByTestId("draft-review-btn"))

    fireEvent.click(screen.getByTestId("draft-reject-btn"))

    await waitFor(() => {
      expect(mockRejectInbox).toHaveBeenCalledWith(
        expect.objectContaining({ id: "cdr_1" }),
        expect.anything()
      )
    })
  })
})

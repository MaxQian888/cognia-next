/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("@/lib/db/outbound-jobs", () => ({
  enqueueOutbound: jest.fn().mockResolvedValue({ id: "oqj_1" }),
}))

jest.mock("@/lib/db/connector-drafts", () => ({
  approveDraft: jest.fn().mockResolvedValue(undefined),
  rejectDraft: jest.fn().mockResolvedValue(undefined),
}))

import { DraftEditor } from "./draft-editor"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { approveDraft, rejectDraft } from "@/lib/db/connector-drafts"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import type { MessageSegment } from "@/types/connectors/segment"

const mockEnqueue = enqueueOutbound as jest.Mock
const mockApprove = approveDraft as jest.Mock
const mockReject = rejectDraft as jest.Mock

function makeDraft(segments: MessageSegment[], hasPreview = true): ConnectorDraftRow {
  return {
    id: "cdr_1",
    conversationKey: "ck1",
    sessionId: "s1",
    segments,
    status: "pending",
    createdAt: 1000,
    outboundPreview: hasPreview
      ? {
          conversationRef: { platform: "telegram", adapterId: "a1", chatId: 5 },
          segments,
          metadata: { idempotencyKey: "idem_1" },
        }
      : undefined,
  }
}

beforeEach(() => {
  mockEnqueue.mockReset().mockResolvedValue({ id: "oqj_1" })
  mockApprove.mockReset().mockResolvedValue(undefined)
  mockReject.mockReset().mockResolvedValue(undefined)
})

describe("DraftEditor", () => {
  it("renders text segments as editable Textareas", () => {
    const draft = makeDraft([{ type: "text", text: "hello" }])
    render(<DraftEditor draft={draft} onClose={() => {}} />)
    expect(screen.getByTestId("draft-segment-text-0")).toHaveValue("hello")
  })

  it("renders markdown segments as a font-mono Textarea seeded with `md`", () => {
    const draft = makeDraft([{ type: "markdown", md: "# heading" }])
    render(<DraftEditor draft={draft} onClose={() => {}} />)
    const ta = screen.getByTestId("draft-segment-markdown-0")
    expect(ta).toHaveValue("# heading")
  })

  it("editing a text segment forwards the new value into enqueueOutbound on approve", async () => {
    const draft = makeDraft([{ type: "text", text: "old" }])
    const onClose = jest.fn()
    render(<DraftEditor draft={draft} onClose={onClose} />)

    fireEvent.change(screen.getByTestId("draft-segment-text-0"), {
      target: { value: "edited" },
    })
    fireEvent.click(screen.getByTestId("draft-approve-btn"))

    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          adapterId: "a1",
          conversationKey: "ck1",
          request: expect.objectContaining({
            segments: [{ type: "text", text: "edited" }],
          }),
        })
      )
      expect(mockApprove).toHaveBeenCalledWith("cdr_1")
      expect(onClose).toHaveBeenCalled()
    })
  })

  it("editing a markdown segment writes back to the `md` field", async () => {
    const draft = makeDraft([{ type: "markdown", md: "# old" }])
    render(<DraftEditor draft={draft} onClose={() => {}} />)

    fireEvent.change(screen.getByTestId("draft-segment-markdown-0"), {
      target: { value: "# new" },
    })
    fireEvent.click(screen.getByTestId("draft-approve-btn"))

    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            segments: [{ type: "markdown", md: "# new" }],
          }),
        })
      )
    })
  })

  it("renders read-only segments for image / video / voice / file / unknown", () => {
    const draft = makeDraft([
      { type: "image", url: "blob:img" },
      { type: "video", url: "blob:vid" },
      { type: "voice", url: "blob:voice" },
      {
        type: "file",
        name: "doc.pdf",
        url: "blob:file",
        mimeType: "application/pdf",
        sizeBytes: 0,
      },
    ])
    render(<DraftEditor draft={draft} onClose={() => {}} />)
    expect(screen.getByTestId("draft-segment-readonly-0")).toHaveTextContent("blob:img")
    expect(screen.getByTestId("draft-segment-readonly-1")).toHaveTextContent("blob:vid")
    expect(screen.getByTestId("draft-segment-readonly-2")).toHaveTextContent("blob:voice")
    expect(screen.getByTestId("draft-segment-readonly-3")).toHaveTextContent("doc.pdf")
  })

  it("falls back to the [segment] label for non-url, non-file segment kinds", () => {
    const draft = makeDraft([{ type: "mention", handle: "@alice" } as unknown as MessageSegment])
    render(<DraftEditor draft={draft} onClose={() => {}} />)
    expect(screen.getByTestId("draft-segment-readonly-0")).toHaveTextContent("[segment]")
  })

  it("approve skips enqueueOutbound when the draft has no outboundPreview", async () => {
    const draft = makeDraft([{ type: "text", text: "hi" }], false)
    const onClose = jest.fn()
    render(<DraftEditor draft={draft} onClose={onClose} />)

    fireEvent.click(screen.getByTestId("draft-approve-btn"))

    await waitFor(() => {
      expect(mockApprove).toHaveBeenCalledWith("cdr_1")
      expect(onClose).toHaveBeenCalled()
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it("reject calls rejectDraft and onClose without touching enqueueOutbound", async () => {
    const draft = makeDraft([{ type: "text", text: "no" }])
    const onClose = jest.fn()
    render(<DraftEditor draft={draft} onClose={onClose} />)

    fireEvent.click(screen.getByTestId("draft-reject-btn"))

    await waitFor(() => {
      expect(mockReject).toHaveBeenCalledWith("cdr_1")
      expect(onClose).toHaveBeenCalled()
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it("cancel button invokes onClose without dispatching any side-effect", () => {
    const draft = makeDraft([{ type: "text", text: "hi" }])
    const onClose = jest.fn()
    render(<DraftEditor draft={draft} onClose={onClose} />)
    fireEvent.click(screen.getByTestId("draft-cancel-btn"))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(mockApprove).not.toHaveBeenCalled()
    expect(mockReject).not.toHaveBeenCalled()
  })
})

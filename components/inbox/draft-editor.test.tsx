/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

// ADR-0131: the editor no longer enqueues delivery itself — `useDraftApproval`
// hands the (edited) segments to the inbox-write facade, which enqueues the
// governed job on a connector host or relays it to a paired one.
jest.mock("@/lib/connectors/inbox-writes", () => ({
  approveInboxDraft: jest.fn().mockResolvedValue({ route: "local", draftId: "cdr_1" }),
  rejectInboxDraft: jest.fn().mockResolvedValue({ route: "local", draftId: "cdr_1" }),
}))

import { DraftEditor } from "./draft-editor"
import { approveInboxDraft, rejectInboxDraft } from "@/lib/connectors/inbox-writes"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import type { MessageSegment } from "@/types/connectors/segment"

const mockApprove = approveInboxDraft as jest.Mock
const mockReject = rejectInboxDraft as jest.Mock

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
  mockApprove.mockReset().mockResolvedValue({ route: "local", draftId: "cdr_1" })
  mockReject.mockReset().mockResolvedValue({ route: "local", draftId: "cdr_1" })
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

  it("editing a text segment forwards the new value to the facade on approve", async () => {
    const draft = makeDraft([{ type: "text", text: "old" }])
    const onClose = jest.fn()
    render(<DraftEditor draft={draft} onClose={onClose} />)

    fireEvent.change(screen.getByTestId("draft-segment-text-0"), {
      target: { value: "edited" },
    })
    fireEvent.click(screen.getByTestId("draft-approve-btn"))

    await waitFor(() => {
      expect(mockApprove).toHaveBeenCalledWith(
        draft,
        expect.objectContaining({ segments: [{ type: "text", text: "edited" }] })
      )
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
      expect(mockApprove).toHaveBeenCalledWith(
        draft,
        expect.objectContaining({ segments: [{ type: "markdown", md: "# new" }] })
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

  it("a2ui segments render as a read-only preview with the plain-text mirror (G5)", () => {
    const draft = makeDraft([
      {
        type: "a2ui",
        surfaceId: "sfc_42",
        content: {
          components: { root: { id: "root", component: "Card", title: "Daily" } },
          dataModel: {},
          rootId: "root",
        },
        plainTextMirror: "# Daily\n[Go]",
      },
    ])
    render(<DraftEditor draft={draft} onClose={() => {}} />)
    const preview = screen.getByTestId("draft-segment-a2ui-0")
    expect(preview).toHaveTextContent("sfc_42")
    expect(preview).toHaveTextContent("# Daily")
    expect(preview).toHaveTextContent("[Go]")
  })

  it("a2ui segment with empty plainTextMirror falls back to the localized hint", () => {
    const draft = makeDraft([
      {
        type: "a2ui",
        surfaceId: "sfc_empty",
        content: { components: {}, dataModel: {}, rootId: "root" },
        plainTextMirror: "",
      },
    ])
    render(<DraftEditor draft={draft} onClose={() => {}} />)
    const preview = screen.getByTestId("draft-segment-a2ui-0")
    expect(preview).toHaveTextContent(/no text mirror|interactive surface|无文本镜像/i)
  })

  it("still approves a draft with no outboundPreview — the facade resolves the binding", async () => {
    // Every `draft-prepare` draft lands without a preview; resolving the
    // delivery target from the session is the facade's job now, so the editor
    // must not gate the approve on it.
    const draft = makeDraft([{ type: "text", text: "hi" }], false)
    const onClose = jest.fn()
    render(<DraftEditor draft={draft} onClose={onClose} />)

    fireEvent.click(screen.getByTestId("draft-approve-btn"))

    await waitFor(() => {
      expect(mockApprove).toHaveBeenCalledWith(draft, expect.anything())
      expect(onClose).toHaveBeenCalled()
    })
  })

  it("reject routes through the facade and closes, without approving", async () => {
    const draft = makeDraft([{ type: "text", text: "no" }])
    const onClose = jest.fn()
    render(<DraftEditor draft={draft} onClose={onClose} />)

    fireEvent.click(screen.getByTestId("draft-reject-btn"))

    await waitFor(() => {
      expect(mockReject).toHaveBeenCalledWith(draft, expect.anything())
      expect(onClose).toHaveBeenCalled()
    })
    expect(mockApprove).not.toHaveBeenCalled()
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

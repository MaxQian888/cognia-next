/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"

import { useDraftApproval } from "./use-draft-approval"
import { approveInboxDraft, rejectInboxDraft } from "@/lib/connectors/inbox-writes"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import type { MessageSegment } from "@/types/connectors/segment"

// ADR-0131: the hook delegates to the shell-agnostic inbox-write facade
// instead of poking Dexie directly, so the route (local host vs. relayed to a
// paired host) is decided in one place rather than per surface.
jest.mock("@/lib/connectors/inbox-writes", () => ({
  approveInboxDraft: jest.fn().mockResolvedValue({ route: "local", draftId: "cdr_1" }),
  rejectInboxDraft: jest.fn().mockResolvedValue({ route: "local", draftId: "cdr_1" }),
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
import { toast } from "sonner"
const mockToastSuccess = toast.success as jest.Mock
const mockToastError = toast.error as jest.Mock

const mockApprove = approveInboxDraft as jest.Mock
const mockReject = rejectInboxDraft as jest.Mock

function makeDraft(overrides: Partial<ConnectorDraftRow> = {}): ConnectorDraftRow {
  return {
    id: "cdr_1",
    conversationKey: "ck1",
    sessionId: "s1",
    segments: [{ type: "text", text: "Hello" }],
    status: "pending",
    createdAt: 1000,
    ...overrides,
  }
}

beforeEach(() => {
  mockToastSuccess.mockReset()
  mockToastError.mockReset()
  mockApprove.mockReset().mockResolvedValue({ route: "local", draftId: "cdr_1" })
  mockReject.mockReset().mockResolvedValue({ route: "local", draftId: "cdr_1" })
})

describe("useDraftApproval", () => {
  it("seeds segments from the draft", () => {
    const draft = makeDraft({
      segments: [
        { type: "text", text: "first" },
        { type: "markdown", md: "# second" },
      ],
    })
    const { result } = renderHook(() => useDraftApproval(draft))
    expect(result.current.segments).toEqual(draft.segments)
    expect(result.current.busy).toBe(false)
  })

  it("setSegment edits text segments", () => {
    const draft = makeDraft({ segments: [{ type: "text", text: "old" }] })
    const { result } = renderHook(() => useDraftApproval(draft))
    act(() => {
      result.current.setSegment(0, "new")
    })
    expect((result.current.segments[0] as { type: "text"; text: string }).text).toBe("new")
  })

  it("setSegment edits markdown segments via the `md` field", () => {
    const draft = makeDraft({ segments: [{ type: "markdown", md: "# old" }] })
    const { result } = renderHook(() => useDraftApproval(draft))
    act(() => {
      result.current.setSegment(0, "# new")
    })
    expect((result.current.segments[0] as { type: "markdown"; md: string }).md).toBe("# new")
  })

  it("setSegment leaves non-editable segments untouched", () => {
    const segs: MessageSegment[] = [
      { type: "image", url: "blob:img" },
      { type: "text", text: "hi" },
    ]
    const draft = makeDraft({ segments: segs })
    const { result } = renderHook(() => useDraftApproval(draft))
    act(() => {
      result.current.setSegment(0, "ignored")
    })
    expect(result.current.segments[0]).toEqual(segs[0])
  })

  it("setSegment ignores out-of-range indices", () => {
    const draft = makeDraft({ segments: [{ type: "text", text: "hi" }] })
    const { result } = renderHook(() => useDraftApproval(draft))
    act(() => {
      result.current.setSegment(99, "nope")
    })
    expect(result.current.segments).toEqual(draft.segments)
  })

  it("approve delegates to the facade with the draft, then calls onComplete", async () => {
    const draft = makeDraft()
    const onComplete = jest.fn()
    const { result } = renderHook(() =>
      useDraftApproval(draft, { onComplete, label: "Reply to Ada" })
    )
    await act(async () => {
      await result.current.approve()
    })
    expect(mockApprove).toHaveBeenCalledWith(draft, {
      segments: draft.segments,
      label: "Reply to Ada",
    })
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it("approve ships the EDITED segments, not the draft's originals", async () => {
    // The whole point of the editor: what the operator approved is what gets
    // delivered — on the phone that means the edits ride the relay RPC.
    const draft = makeDraft({ segments: [{ type: "text", text: "original" }] })
    const { result } = renderHook(() => useDraftApproval(draft))
    act(() => {
      result.current.setSegment(0, "edited")
    })
    await act(async () => {
      await result.current.approve()
    })
    expect(mockApprove.mock.calls[0][1].segments).toEqual([{ type: "text", text: "edited" }])
  })

  it("approve runs beforeApprove with the current edited segments", async () => {
    const draft = makeDraft({ segments: [{ type: "text", text: "original" }] })
    const beforeApprove = jest.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useDraftApproval(draft, { beforeApprove }))
    act(() => {
      result.current.setSegment(0, "edited")
    })
    await act(async () => {
      await result.current.approve()
    })
    expect(beforeApprove).toHaveBeenCalledWith({
      draft,
      segments: [{ type: "text", text: "edited" }],
    })
    expect(beforeApprove.mock.invocationCallOrder[0]).toBeLessThan(
      mockApprove.mock.invocationCallOrder[0]
    )
  })

  it("approve sets busy=true during the call and false after success", async () => {
    const draft = makeDraft()
    let resolveApprove: (() => void) | undefined
    mockApprove.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveApprove = resolve
        })
    )
    const { result } = renderHook(() => useDraftApproval(draft))

    let pending: Promise<unknown> | undefined
    act(() => {
      pending = result.current.approve()
    })
    expect(result.current.busy).toBe(true)
    await act(async () => {
      resolveApprove?.()
      await pending
    })
    expect(result.current.busy).toBe(false)
  })

  it("approve never throws: it toasts the failure and returns it", async () => {
    // Both callers fire approve from a button or a swipe (`void approve()`); a
    // rejected promise there was an unhandled rejection and a silent no-op.
    const draft = makeDraft()
    const error = new Error("kaboom")
    mockApprove.mockRejectedValueOnce(error)
    const onComplete = jest.fn()
    const { result } = renderHook(() => useDraftApproval(draft, { onComplete }))
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.approve()
    })
    expect(outcome).toEqual({ ok: false, action: "approve", error })
    expect(mockToastError).toHaveBeenCalledWith("Couldn't send the draft", {
      description: "Please try again.",
    })
    expect(result.current.busy).toBe(false)
    expect(onComplete).not.toHaveBeenCalled()
  })

  it("approve reports a failure from beforeApprove without writing", async () => {
    const draft = makeDraft()
    const beforeApprove = jest.fn().mockRejectedValue(new Error("preflight"))
    const { result } = renderHook(() => useDraftApproval(draft, { beforeApprove }))
    let outcome: { ok: boolean } | undefined
    await act(async () => {
      outcome = await result.current.approve()
    })
    expect(outcome?.ok).toBe(false)
    expect(mockApprove).not.toHaveBeenCalled()
    expect(result.current.busy).toBe(false)
  })

  it("approve toasts success, distinguishing a relayed (queued) approval", async () => {
    const draft = makeDraft()
    const { result } = renderHook(() => useDraftApproval(draft))
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.approve()
    })
    expect(outcome).toEqual({ ok: true, action: "approve", route: "local" })
    expect(mockToastSuccess).toHaveBeenLastCalledWith("Draft sent")

    mockApprove.mockResolvedValueOnce({ route: "remote", draftId: "cdr_1" })
    await act(async () => {
      await result.current.approve()
    })
    expect(mockToastSuccess).toHaveBeenLastCalledWith("Draft approved — your host will send it")
  })

  it("stays quiet when notify is off but still returns the outcome", async () => {
    const draft = makeDraft()
    mockReject.mockRejectedValueOnce("offline")
    const { result } = renderHook(() => useDraftApproval(draft, { notify: false }))
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.reject()
    })
    expect(outcome).toEqual({ ok: false, action: "reject", error: "offline" })
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it("tracks dirtiness by content and resets edits", () => {
    const draft = makeDraft({ segments: [{ type: "text", text: "original" }] })
    const { result } = renderHook(() => useDraftApproval(draft))
    expect(result.current.dirty).toBe(false)
    act(() => result.current.setSegment(0, "edited"))
    expect(result.current.dirty).toBe(true)
    act(() => result.current.setSegment(0, "original"))
    // Typing the original text back is not an edit.
    expect(result.current.dirty).toBe(false)
    act(() => result.current.setSegment(0, "edited again"))
    act(() => result.current.resetSegments())
    expect(result.current.segments).toEqual(draft.segments)
    expect(result.current.dirty).toBe(false)
  })

  it("reject runs beforeReject, delegates to the facade, then onComplete", async () => {
    const draft = makeDraft()
    const beforeReject = jest.fn().mockResolvedValue(undefined)
    const onComplete = jest.fn()
    const { result } = renderHook(() => useDraftApproval(draft, { beforeReject, onComplete }))
    await act(async () => {
      await result.current.reject()
    })
    expect(beforeReject).toHaveBeenCalledWith({ draft })
    expect(mockReject).toHaveBeenCalledWith(draft, { label: undefined })
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(beforeReject.mock.invocationCallOrder[0]).toBeLessThan(
      mockReject.mock.invocationCallOrder[0]
    )
  })

  it("reject queues under its own label, not the approve label", async () => {
    const draft = makeDraft()
    const { result } = renderHook(() =>
      useDraftApproval(draft, { label: "Approve draft", rejectLabel: "Reject draft" })
    )
    await act(async () => {
      await result.current.reject()
    })
    expect(mockReject).toHaveBeenCalledWith(draft, { label: "Reject draft" })
  })

  it("reject falls back to the shared label when no reject label is given", async () => {
    const draft = makeDraft()
    const { result } = renderHook(() => useDraftApproval(draft, { label: "Reply to Ada" }))
    await act(async () => {
      await result.current.reject()
    })
    expect(mockReject).toHaveBeenCalledWith(draft, { label: "Reply to Ada" })
  })

  it("reject sets busy true→false across the call", async () => {
    const draft = makeDraft()
    let resolveReject: (() => void) | undefined
    mockReject.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveReject = resolve
        })
    )
    const { result } = renderHook(() => useDraftApproval(draft))

    let pending: Promise<unknown> | undefined
    act(() => {
      pending = result.current.reject()
    })
    expect(result.current.busy).toBe(true)
    await act(async () => {
      resolveReject?.()
      await pending
    })
    expect(result.current.busy).toBe(false)
  })

  it("reject toasts a failure with a fallback description and resets busy", async () => {
    const draft = makeDraft()
    mockReject.mockRejectedValueOnce({})
    const { result } = renderHook(() => useDraftApproval(draft))
    let outcome: { ok: boolean } | undefined
    await act(async () => {
      outcome = await result.current.reject()
    })
    expect(outcome?.ok).toBe(false)
    expect(mockToastError).toHaveBeenCalledWith("Couldn't reject the draft", {
      description: "Please try again.",
    })
    expect(result.current.busy).toBe(false)
  })

  it("reject toasts success per route", async () => {
    const draft = makeDraft()
    const { result } = renderHook(() => useDraftApproval(draft))
    await act(async () => {
      await result.current.reject()
    })
    expect(mockToastSuccess).toHaveBeenLastCalledWith("Draft rejected")
    mockReject.mockResolvedValueOnce({ route: "remote", draftId: "cdr_1" })
    await act(async () => {
      await result.current.reject()
    })
    expect(mockToastSuccess).toHaveBeenLastCalledWith("Rejection sent to your host")
  })
})

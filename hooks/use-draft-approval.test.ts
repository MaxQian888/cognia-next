/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"

import { useDraftApproval } from "./use-draft-approval"
import { approveDraft, rejectDraft } from "@/lib/db/connector-drafts"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import type { MessageSegment } from "@/types/connectors/segment"

jest.mock("@/lib/db/connector-drafts", () => ({
  approveDraft: jest.fn().mockResolvedValue(undefined),
  rejectDraft: jest.fn().mockResolvedValue(undefined),
}))

const mockApprove = approveDraft as jest.Mock
const mockReject = rejectDraft as jest.Mock

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
  mockApprove.mockReset().mockResolvedValue(undefined)
  mockReject.mockReset().mockResolvedValue(undefined)
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

  it("approve calls approveDraft and onComplete in order", async () => {
    const draft = makeDraft()
    const onComplete = jest.fn()
    const { result } = renderHook(() => useDraftApproval(draft, { onComplete }))
    await act(async () => {
      await result.current.approve()
    })
    expect(mockApprove).toHaveBeenCalledWith("cdr_1")
    expect(onComplete).toHaveBeenCalledTimes(1)
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

    let pending: Promise<void> | undefined
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

  it("approve propagates errors and resets busy", async () => {
    const draft = makeDraft()
    mockApprove.mockRejectedValueOnce(new Error("kaboom"))
    const onComplete = jest.fn()
    const { result } = renderHook(() => useDraftApproval(draft, { onComplete }))
    await expect(
      act(async () => {
        await result.current.approve()
      })
    ).rejects.toThrow("kaboom")
    expect(result.current.busy).toBe(false)
    expect(onComplete).not.toHaveBeenCalled()
  })

  it("approve propagates errors thrown from beforeApprove without calling approveDraft", async () => {
    const draft = makeDraft()
    const beforeApprove = jest.fn().mockRejectedValue(new Error("preflight"))
    const { result } = renderHook(() => useDraftApproval(draft, { beforeApprove }))
    await expect(
      act(async () => {
        await result.current.approve()
      })
    ).rejects.toThrow("preflight")
    expect(mockApprove).not.toHaveBeenCalled()
    expect(result.current.busy).toBe(false)
  })

  it("reject calls rejectDraft, beforeReject, then onComplete", async () => {
    const draft = makeDraft()
    const beforeReject = jest.fn().mockResolvedValue(undefined)
    const onComplete = jest.fn()
    const { result } = renderHook(() => useDraftApproval(draft, { beforeReject, onComplete }))
    await act(async () => {
      await result.current.reject()
    })
    expect(beforeReject).toHaveBeenCalledWith({ draft })
    expect(mockReject).toHaveBeenCalledWith("cdr_1")
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(beforeReject.mock.invocationCallOrder[0]).toBeLessThan(
      mockReject.mock.invocationCallOrder[0]
    )
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

    let pending: Promise<void> | undefined
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

  it("reject propagates errors and resets busy", async () => {
    const draft = makeDraft()
    mockReject.mockRejectedValueOnce(new Error("nope"))
    const { result } = renderHook(() => useDraftApproval(draft))
    await expect(
      act(async () => {
        await result.current.reject()
      })
    ).rejects.toThrow("nope")
    expect(result.current.busy).toBe(false)
  })
})

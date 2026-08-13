/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { UIMessage } from "ai"
import { CompactBoundaryMarker, isCompactBoundaryMessage } from "./compact-boundary-part"
import {
  registerUndoSnapshot,
  hasUndoSnapshot,
  __resetUndoRegistryForTesting,
} from "@/lib/claude/compaction-undo"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}))

const restoreSessionMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/claude/ipc", () => ({
  restoreSession: (...args: unknown[]) => restoreSessionMock(...args),
}))

// The optical-archive dialog (rendered when opticalArchiveId is set) reads the
// row via useLiveQuery; stub it + the Dexie helper so this test needs no DB.
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => undefined }))
jest.mock("@/lib/db/optical-archives", () => ({ getOpticalArchive: jest.fn() }))

let mockStoreState: {
  activeSessionId: string | null
  replaceMessages: jest.Mock
  messages: UIMessage[]
}
jest.mock("@/stores/chat", () => ({
  useChatStore: Object.assign((sel: (s: unknown) => unknown) => sel(mockStoreState), {
    getState: () => mockStoreState,
  }),
}))

const boundary = (part: Record<string, unknown>, id = "compact-1"): UIMessage =>
  ({
    id,
    role: "system",
    parts: [{ type: "compact-boundary", ...part }],
  }) as unknown as UIMessage

beforeEach(() => {
  __resetUndoRegistryForTesting()
  toastSuccess.mockClear()
  toastError.mockClear()
  restoreSessionMock.mockClear()
  mockStoreState = {
    activeSessionId: "sess-1",
    replaceMessages: jest.fn(),
    messages: [],
  }
})

describe("isCompactBoundaryMessage", () => {
  it("recognises the synthetic marker", () => {
    expect(isCompactBoundaryMessage(boundary({}))).toBe(true)
  })

  it("rejects ordinary messages", () => {
    const assistant = {
      id: "a",
      role: "assistant",
      parts: [{ type: "text", text: "hi" }],
    } as unknown as UIMessage
    expect(isCompactBoundaryMessage(assistant)).toBe(false)
  })

  it("rejects a system message that is not a boundary", () => {
    const sys = {
      id: "s",
      role: "system",
      parts: [{ type: "text", text: "x" }],
    } as unknown as UIMessage
    expect(isCompactBoundaryMessage(sys)).toBe(false)
  })
})

describe("CompactBoundaryMarker", () => {
  it("shows the before/after token detail when both counts are present", () => {
    render(<CompactBoundaryMarker message={boundary({ preTokens: 120000, postTokens: 8000 })} />)
    expect(screen.getByTestId("compact-boundary")).toBeInTheDocument()
    expect(screen.getByText(/detail:.*120K.*8K/)).toBeInTheDocument()
  })

  it("falls back to the manual label when token counts are absent", () => {
    render(<CompactBoundaryMarker message={boundary({ trigger: "manual" })} />)
    expect(screen.getByText(/manual/)).toBeInTheDocument()
  })

  it("falls back to the auto label otherwise", () => {
    render(<CompactBoundaryMarker message={boundary({ trigger: "auto" })} />)
    expect(screen.getByText(/auto/)).toBeInTheDocument()
  })

  it("shows the phase + reclaimed-percent labels when derivable from the transcript", () => {
    const msg = boundary({ preTokens: 1000, postTokens: 250 }, "b1")
    const assistant = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "hi" }],
      metadata: { usage: { inputTokens: 1000, outputTokens: 0 } },
    } as unknown as UIMessage
    mockStoreState.messages = [assistant, msg]
    render(<CompactBoundaryMarker message={msg} />)
    // turnLabel = 1 assistant turn before the boundary; reclaimed 75%.
    expect(screen.getByTestId("compact-phase")).toHaveTextContent('phase:{"turn":1}')
    expect(screen.getByTestId("compact-effectiveness")).toHaveTextContent(
      'effectiveness:{"pct":75}'
    )
  })

  it("omits the effectiveness label when nothing was reclaimed", () => {
    const msg = boundary({ preTokens: 100, postTokens: 100 }, "b1")
    mockStoreState.messages = [msg]
    render(<CompactBoundaryMarker message={msg} />)
    expect(screen.queryByTestId("compact-effectiveness")).not.toBeInTheDocument()
  })

  it("shows the encrypted checkpoint persistence state", () => {
    render(
      <CompactBoundaryMarker
        message={boundary({ checkpointId: "compact-1", checkpointState: "locked" })}
      />
    )
    expect(screen.getByTestId("compact-checkpoint-state")).toHaveTextContent("checkpoint.locked")
  })

  it("does not show an undo button without a live snapshot", () => {
    render(<CompactBoundaryMarker message={boundary({ undoToken: "compact-1" })} />)
    expect(screen.queryByTestId("compact-undo")).not.toBeInTheDocument()
  })

  it("restores the conversation when undo is clicked", async () => {
    const snapshot = [{ role: "user", content: "m0" }]
    registerUndoSnapshot({ token: "compact-1", createdAt: 1, snapshot })
    const msg = boundary({ undoToken: "compact-1", preTokens: 1, postTokens: 1 })
    mockStoreState.messages = [
      msg,
      { id: "other", role: "user", parts: [] } as unknown as UIMessage,
    ]

    render(<CompactBoundaryMarker message={msg} />)
    const btn = screen.getByTestId("compact-undo")
    await userEvent.click(btn)

    await waitFor(() => expect(restoreSessionMock).toHaveBeenCalledWith("sess-1", snapshot))
    // Boundary marker removed from the transcript; snapshot cleared.
    expect(mockStoreState.replaceMessages).toHaveBeenCalledWith([
      expect.objectContaining({ id: "other" }),
    ])
    expect(hasUndoSnapshot("compact-1")).toBe(false)
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("toasts an error when restore fails", async () => {
    registerUndoSnapshot({ token: "compact-1", createdAt: 1, snapshot: [{ role: "user" }] })
    restoreSessionMock.mockRejectedValueOnce(new Error("boom"))
    render(<CompactBoundaryMarker message={boundary({ undoToken: "compact-1" })} />)
    await userEvent.click(screen.getByTestId("compact-undo"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })

  it("offers a View-frames button that opens the optical archive dialog", async () => {
    render(
      <CompactBoundaryMarker
        message={boundary({ opticalArchiveId: "compact-1", opticalFrameCount: 2 })}
      />
    )
    // No optical archive → no view button on ordinary boundaries.
    expect(screen.queryByTestId("optical-archive-dialog")).not.toBeInTheDocument()
    const btn = screen.getByTestId("compact-view-frames")
    await userEvent.click(btn)
    expect(await screen.findByTestId("optical-archive-dialog")).toBeInTheDocument()
  })

  it("shows no View-frames button on a non-optical boundary", () => {
    render(<CompactBoundaryMarker message={boundary({ trigger: "auto" })} />)
    expect(screen.queryByTestId("compact-view-frames")).not.toBeInTheDocument()
  })
})

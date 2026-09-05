/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"

import {
  useCanvasCollaborativeEditor,
  CANVAS_PROJECTION_DEBOUNCE_MS,
} from "./use-canvas-collaborative-editor"
import { CANVAS_PRESENCE_STYLE_ID } from "@/lib/canvas/collaboration/editor-binding"

jest.mock("y-monaco", () => ({ MonacoBinding: jest.fn() }))
jest.mock("y-codemirror.next", () => ({ yCollab: jest.fn(() => "collab") }))
jest.mock("y-protocols/awareness", () => ({
  Awareness: jest.fn().mockImplementation(() => ({
    outdatedTimeout: 30_000,
    setLocalStateField: jest.fn(),
    destroy: jest.fn(),
  })),
}))

/** A minimal `Y.Text` stand-in: enough to observe and to read back. */
function fakeText(initial: string) {
  const observers = new Set<() => void>()
  let value = initial
  return {
    toString: () => value,
    observe: (fn: () => void) => observers.add(fn),
    unobserve: (fn: () => void) => observers.delete(fn),
    /** Simulate a change arriving, local or remote. */
    write(next: string) {
      value = next
      for (const observer of observers) observer()
    },
  }
}

let sessionId: string | null = "session-1"
let text = fakeText("hello")
const sessionListeners = new Set<() => void>()
const participants = [{ id: "p-self", name: "Ada", color: "#f00" }]

jest.mock("@/lib/canvas/collaboration/crdt-store", () => ({
  crdtStore: {
    onSessionsChanged: (listener: () => void) => {
      sessionListeners.add(listener)
      return () => sessionListeners.delete(listener)
    },
    sessionIdForDocument: () => sessionId,
    getYDoc: () => ({ id: "doc" }),
    getYText: () => text,
    getSession: () => ({ id: "session-1", participants }),
    getLocalParticipantId: () => "p-self",
  },
}))

const updateCanvasDocument = jest.fn()
const canvasDocuments: Record<string, { content: string }> = {
  "doc-1": { content: "hello" },
}
jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: {
    getState: () => ({ canvasDocuments, updateCanvasDocument }),
  },
}))

const collaboration = {
  enabled: true,
  showCursors: true,
  showSelections: true,
  cursorSmoothing: false,
  presenceTimeout: 30_000,
  showAvatars: true,
}
jest.mock("@/stores/canvas/canvas-settings-store", () => ({
  useCanvasSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { collaboration } }),
}))

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers()
  sessionId = "session-1"
  text = fakeText("hello")
  canvasDocuments["doc-1"] = { content: "hello" }
  collaboration.enabled = true
  collaboration.showCursors = true
  collaboration.presenceTimeout = 30_000
  document.getElementById(CANVAS_PRESENCE_STYLE_ID)?.remove()
})

afterEach(() => {
  jest.useRealTimers()
})

function render(documentId: string | null = "doc-1", enabled = true) {
  return renderHook(() => useCanvasCollaborativeEditor({ documentId, enabled }))
}

describe("session discovery", () => {
  it("becomes active once a session exists for the document", async () => {
    const { result } = render()
    await waitFor(() => expect(result.current.active).toBe(true))
    expect(result.current.codeMirrorExtensions).toEqual(["collab"])
  })

  it("stays inactive when the feature flag is off", async () => {
    const { result } = render("doc-1", false)
    await act(async () => {})
    expect(result.current.active).toBe(false)
    expect(result.current.codeMirrorExtensions).toEqual([])
  })

  it("stays inactive when collaboration is switched off in settings", async () => {
    collaboration.enabled = false
    const { result } = render()
    await act(async () => {})
    expect(result.current.active).toBe(false)
  })

  it("stays inactive when no session has been opened", async () => {
    sessionId = null
    const { result } = render()
    await act(async () => {})
    expect(result.current.active).toBe(false)
  })

  it("hands back a referentially stable empty extension list", async () => {
    sessionId = null
    const { result, rerender } = render()
    const first = result.current.codeMirrorExtensions
    rerender()
    // An unstable empty array would reconfigure CodeMirror on every render.
    expect(result.current.codeMirrorExtensions).toBe(first)
  })
})

describe("the projection back into the store", () => {
  it("writes the shared text into the document after it settles", async () => {
    render()
    await act(async () => {})
    act(() => {
      text.write("hello world")
    })
    expect(updateCanvasDocument).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(CANVAS_PROJECTION_DEBOUNCE_MS)
    })
    expect(updateCanvasDocument).toHaveBeenCalledWith(
      "doc-1",
      expect.objectContaining({ content: "hello world" })
    )
  })

  it("coalesces a burst of keystrokes into one write", async () => {
    // The store write is a re-render, a localStorage write and an IndexedDB
    // transaction. None of that belongs on a keystroke.
    render()
    await act(async () => {})
    act(() => {
      text.write("h")
      text.write("he")
      text.write("hel")
      jest.advanceTimersByTime(CANVAS_PROJECTION_DEBOUNCE_MS)
    })
    expect(updateCanvasDocument).toHaveBeenCalledTimes(1)
    expect(updateCanvasDocument).toHaveBeenCalledWith(
      "doc-1",
      expect.objectContaining({ content: "hel" })
    )
  })

  it("writes nothing when the text did not actually change", async () => {
    render()
    await act(async () => {})
    act(() => {
      text.write("hello")
      jest.advanceTimersByTime(CANVAS_PROJECTION_DEBOUNCE_MS)
    })
    expect(updateCanvasDocument).not.toHaveBeenCalled()
  })

  it("flushes the last characters when the document is switched away", async () => {
    const { unmount } = render()
    await act(async () => {})
    act(() => {
      text.write("typed just before leaving")
    })
    act(() => {
      unmount()
    })
    // Losing these to a pending timer is losing what the user just typed.
    expect(updateCanvasDocument).toHaveBeenCalledWith(
      "doc-1",
      expect.objectContaining({ content: "typed just before leaving" })
    )
  })
})

describe("the presence stylesheet", () => {
  it("is injected once a session is live", async () => {
    render()
    await act(async () => {})
    expect(document.getElementById(CANVAS_PRESENCE_STYLE_ID)).not.toBeNull()
  })

  it("is not injected when there is no session to draw for", async () => {
    sessionId = null
    render()
    await act(async () => {})
    expect(document.getElementById(CANVAS_PRESENCE_STYLE_ID)).toBeNull()
  })

  it("replaces its contents rather than stacking a second sheet", async () => {
    const { rerender } = render()
    await act(async () => {})
    collaboration.showCursors = false
    rerender()
    await act(async () => {})
    expect(document.querySelectorAll(`#${CANVAS_PRESENCE_STYLE_ID}`)).toHaveLength(1)
    expect(document.getElementById(CANVAS_PRESENCE_STYLE_ID)?.textContent).toContain(
      "display: none"
    )
  })

  it("is removed when the editor goes away", async () => {
    const { unmount } = render()
    await act(async () => {})
    act(() => {
      unmount()
    })
    expect(document.getElementById(CANVAS_PRESENCE_STYLE_ID)).toBeNull()
  })
})

describe("presence timeout", () => {
  it("pushes the configured cutoff onto the live awareness", async () => {
    // The setting stopped being a stored number and started deciding when a
    // silent peer leaves the roster.
    collaboration.presenceTimeout = 12_000
    const { result } = render()
    await waitFor(() => expect(result.current.active).toBe(true))
    const { Awareness } = jest.requireMock("y-protocols/awareness") as { Awareness: jest.Mock }
    const instance = Awareness.mock.results[0].value as { outdatedTimeout: number }
    expect(instance.outdatedTimeout).toBe(12_000)
  })

  it("clamps a cutoff that would evict everybody immediately", async () => {
    collaboration.presenceTimeout = 0
    const { result } = render()
    await waitFor(() => expect(result.current.active).toBe(true))
    const { Awareness } = jest.requireMock("y-protocols/awareness") as { Awareness: jest.Mock }
    const instance = Awareness.mock.results[0].value as { outdatedTimeout: number }
    expect(instance.outdatedTimeout).toBeGreaterThanOrEqual(5_000)
  })
})

describe("bindMonaco", () => {
  it("refuses to bind when no session is live", async () => {
    sessionId = null
    const { result } = render()
    await act(async () => {})
    const editor = { getModel: () => ({}) } as never
    await expect(result.current.bindMonaco(editor)).resolves.toBeNull()
  })

  it("binds once a session is live", async () => {
    const { result } = render()
    await waitFor(() => expect(result.current.active).toBe(true))
    const editor = { getModel: () => ({ id: "model" }) } as never
    const teardown = await result.current.bindMonaco(editor)
    expect(teardown).toBeInstanceOf(Function)
  })
})

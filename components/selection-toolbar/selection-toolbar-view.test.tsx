/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"

jest.mock("motion/react", () => jest.requireActual("../../__mocks__/motion-react.js"))

const listeners = new Map<string, (event: { payload: unknown }) => void>()
const emitToMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, handler)
    return jest.fn()
  },
  emitTo: (...args: unknown[]) => emitToMock(...args),
}))

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/tauri/os", () => ({ isMacPlatform: () => true }))

const executeMock = jest.fn().mockResolvedValue(undefined)
const currentMock = jest.fn()
const revealMock = jest.fn().mockResolvedValue(undefined)
const interactiveMock = jest.fn().mockResolvedValue(undefined)
const keepAliveMock = jest.fn().mockResolvedValue(undefined)
const finishMock = jest.fn().mockResolvedValue(undefined)
const chordsMock = jest.fn()
jest.mock("@/lib/tauri/selection-toolbar", () => ({
  SELECTION_CANDIDATE_EVENT: "selection://candidate",
  SELECTION_DISMISS_EVENT: "selection://dismiss",
  SELECTION_ESCAPE_EVENT: "selection://escape",
  SELECTION_SHORTCUT_EVENT: "selection://shortcut",
  SELECTION_RESULT_EVENT: "selection://result",
  SELECTION_SPEECH_EVENT: "selection://speech",
  SELECTION_SPEECH_STOP_EVENT: "selection://speech-stop",
  SELECTION_SHADOW_PAD: 20,
  executeSelectionToolbarAction: (...args: unknown[]) => executeMock(...args),
  getCurrentSelectionCandidate: () => currentMock(),
  revealSelectionToolbar: () => revealMock(),
  setSelectionToolbarInteractive: (...args: unknown[]) => interactiveMock(...args),
  setSelectionToolbarKeepAlive: (...args: unknown[]) => keepAliveMock(...args),
  finishSelectionToolbar: (...args: unknown[]) => finishMock(...args),
  listShortcutChords: () => chordsMock(),
}))

const getPrefMock = jest.fn()
const setPrefMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/store", () => ({
  getPref: (...args: unknown[]) => getPrefMock(...args),
  setPref: (...args: unknown[]) => setPrefMock(...args),
}))

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({
    number: (value: number, opts?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat("en-US", opts).format(value),
  }),
}))

// Geometry is exercised in its own suite; here it only has to report "measured"
// so the reveal path runs.
let placement: "above" | "below" = "above"
let measured = true
jest.mock("./use-selection-toolbar-geometry", () => ({
  useSelectionToolbarGeometry: () => ({
    shellRef: { current: null },
    capsuleRef: { current: null },
    panelRef: { current: null },
    ghostRef: { current: null },
    placement,
    measured,
    remeasure: jest.fn(),
  }),
}))

import { SelectionToolbarView } from "./selection-toolbar-view"

const candidate = {
  id: "candidate-1",
  // Prose on purpose. A short phrase classifies as a search `term`, which
  // mints a contextual button that takes the last slot from `speak` — correct
  // behaviour, covered in `selection-toolbar-actions.test.ts`, but it would
  // couple every test here to the classifier. These tests are about the
  // toolbar's wiring, so they use text that earns exactly the stable six.
  text: "The selected sentence the toolbar is acting on, long enough not to read as a query.",
  sourceApp: "TextEdit",
  sourceTitle: "Draft",
  origin: "accessibility" as const,
  capturedAt: 1,
  truncated: false,
}

function emit(event: string, payload: unknown) {
  return act(async () => {
    listeners.get(event)?.({ payload })
  })
}

function capsule() {
  return screen.getByTestId("selection-toolbar-capsule")
}

beforeEach(() => {
  listeners.clear()
  jest.clearAllMocks()
  placement = "above"
  measured = true
  currentMock.mockResolvedValue(candidate)
  chordsMock.mockResolvedValue({ "selection.copy": "alt+shift+1" })
  getPrefMock.mockResolvedValue(null)
})

describe("SelectionToolbarView", () => {
  it("hydrates the live candidate and reveals the window once it has been measured", async () => {
    render(<SelectionToolbarView />)
    expect(await screen.findByRole("button", { name: "copy" })).toBeInTheDocument()
    await waitFor(() => expect(revealMock).toHaveBeenCalled())
    expect(document.documentElement).toHaveAttribute("data-selection-toolbar")
  })

  it("does not reveal an unmeasured window, which on Windows would paint black", async () => {
    measured = false
    render(<SelectionToolbarView />)
    await screen.findByRole("button", { name: "copy" })
    expect(revealMock).not.toHaveBeenCalled()
  })

  it("shows a checkmark for copy and only then releases the toolbar", async () => {
    jest.useFakeTimers({ doNotFake: ["queueMicrotask"] })
    try {
      render(<SelectionToolbarView />)
      await act(async () => {})
      fireEvent.click(within(capsule()).getByRole("button", { name: "copy" }))
      await act(async () => {})

      expect(executeMock).toHaveBeenCalledWith("candidate-1", { kind: "copy" })
      expect(finishMock).not.toHaveBeenCalled()
      await act(async () => {
        jest.advanceTimersByTime(420)
      })
      expect(finishMock).toHaveBeenCalledWith("candidate-1")
    } finally {
      jest.useRealTimers()
    }
  })

  it("leaves handoff actions to Rust rather than holding the toolbar open", async () => {
    render(<SelectionToolbarView />)
    await act(async () => {})
    fireEvent.click(within(capsule()).getByRole("button", { name: "ask" }))
    await act(async () => {})
    expect(executeMock).toHaveBeenCalledWith("candidate-1", { kind: "ask" })
    expect(finishMock).not.toHaveBeenCalled()
  })

  it("waits for the main window before deciding a memory succeeded", async () => {
    render(<SelectionToolbarView />)
    await act(async () => {})
    fireEvent.click(within(capsule()).getByRole("button", { name: "remember" }))
    await act(async () => {})
    expect(finishMock).not.toHaveBeenCalled()

    await emit("selection://result", { candidateId: "candidate-1", ok: true })
    expect(finishMock).not.toHaveBeenCalled() // the ✓ still has to be seen
  })

  it("surfaces a PII block instead of vanishing silently", async () => {
    render(<SelectionToolbarView />)
    await act(async () => {})
    fireEvent.click(within(capsule()).getByRole("button", { name: "remember" }))
    await act(async () => {})
    await emit("selection://result", {
      candidateId: "candidate-1",
      ok: false,
      reason: "pii_blocked",
    })
    expect(screen.getByRole("alert")).toHaveTextContent("errors.piiBlocked")
  })

  it("ignores a result meant for a superseded candidate", async () => {
    render(<SelectionToolbarView />)
    await act(async () => {})
    fireEvent.click(within(capsule()).getByRole("button", { name: "remember" }))
    await act(async () => {})
    await emit("selection://result", { candidateId: "other", ok: false, reason: "pii_blocked" })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("drives the transport from main-window playback and releases when it ends", async () => {
    render(<SelectionToolbarView />)
    await act(async () => {})
    fireEvent.click(within(capsule()).getByRole("button", { name: "speak" }))
    await act(async () => {})

    await emit("selection://speech", {
      candidateId: "candidate-1",
      playing: true,
      progress: 0.3,
    })
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "30")

    await emit("selection://speech", { candidateId: "candidate-1", playing: false })
    expect(finishMock).toHaveBeenCalledWith("candidate-1")
  })

  it("asks the main window to stop speech rather than stopping a player it does not own", async () => {
    render(<SelectionToolbarView />)
    await act(async () => {})
    fireEvent.click(within(capsule()).getByRole("button", { name: "speak" }))
    await act(async () => {})
    await emit("selection://speech", { candidateId: "candidate-1", playing: true })

    fireEvent.click(within(capsule()).getByRole("button", { name: "stopSpeaking" }))
    expect(emitToMock).toHaveBeenCalledWith("main", "selection://speech-stop", {
      candidateId: "candidate-1",
    })
  })

  it("runs the same path for a chord as for a click", async () => {
    render(<SelectionToolbarView />)
    await act(async () => {})
    await emit("selection://shortcut", {
      shortcutId: "selection.remember",
      candidateId: "candidate-1",
    })
    expect(executeMock).toHaveBeenCalledWith("candidate-1", { kind: "remember" })
  })

  it("ignores a chord aimed at a candidate that has already gone", async () => {
    render(<SelectionToolbarView />)
    await act(async () => {})
    await emit("selection://shortcut", { shortcutId: "selection.copy", candidateId: "stale" })
    expect(executeMock).not.toHaveBeenCalled()
  })

  it("freezes the idle countdown while the pointer is on the capsule", async () => {
    render(<SelectionToolbarView />)
    await act(async () => {})
    keepAliveMock.mockClear()
    fireEvent.pointerEnter(within(capsule()).getByRole("button", { name: "copy" }).parentElement!)
    await waitFor(() => expect(keepAliveMock).toHaveBeenCalledWith(true))
  })

  it("persists the chosen translation target and translates with it", async () => {
    render(<SelectionToolbarView />)
    await act(async () => {})
    fireEvent.click(within(capsule()).getByRole("button", { name: "chooseLanguage" }))
    await act(async () => {})
    fireEvent.click(screen.getByRole("option", { name: /languages.ja/ }))
    await act(async () => {})

    expect(setPrefMock).toHaveBeenCalledWith("selectionToolbar.translateLocale", "ja")
    expect(executeMock).toHaveBeenCalledWith("candidate-1", {
      kind: "translate",
      targetLocale: "ja",
    })
  })

  it("restores the persisted translation target", async () => {
    getPrefMock.mockResolvedValue("de")
    render(<SelectionToolbarView />)
    await act(async () => {})
    fireEvent.click(within(capsule()).getByRole("button", { name: "translate" }))
    await act(async () => {})
    expect(executeMock).toHaveBeenCalledWith("candidate-1", {
      kind: "translate",
      targetLocale: "de",
    })
  })

  it("swaps to a fresh candidate and resets any in-flight state", async () => {
    render(<SelectionToolbarView />)
    await act(async () => {})
    fireEvent.click(within(capsule()).getByRole("button", { name: "remember" }))
    await act(async () => {})
    await emit("selection://result", {
      candidateId: "candidate-1",
      ok: false,
      reason: "pii_blocked",
    })
    expect(screen.getByRole("alert")).toBeInTheDocument()

    await emit("selection://candidate", { ...candidate, id: "candidate-2", truncated: true })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(within(capsule()).getByText("truncated")).toBeInTheDocument()
  })

  it("unmounts the capsule on dismiss so the exit animation can play", async () => {
    render(<SelectionToolbarView />)
    await act(async () => {})
    await emit("selection://dismiss", { reason: "idle" })
    expect(screen.queryByTestId("selection-toolbar-capsule")).not.toBeInTheDocument()
  })

  it("anchors to the edge Rust pinned, so the capsule stays put as the window grows", async () => {
    placement = "below"
    render(<SelectionToolbarView />)
    await act(async () => {})
    expect(screen.getByTestId("selection-toolbar")).toHaveClass("items-start")
  })

  it("shows an error rather than hanging when the action itself fails", async () => {
    executeMock.mockRejectedValueOnce(new Error("candidate is stale"))
    render(<SelectionToolbarView />)
    await act(async () => {})
    fireEvent.click(within(capsule()).getByRole("button", { name: "copy" }))
    await act(async () => {})
    expect(screen.getByRole("alert")).toHaveTextContent("errors.generic")
  })

  it("ignores a second click while one action is already pending", async () => {
    render(<SelectionToolbarView />)
    await act(async () => {})
    fireEvent.click(within(capsule()).getByRole("button", { name: "remember" }))
    await act(async () => {})
    executeMock.mockClear()
    fireEvent.click(within(capsule()).getByRole("button", { name: "speak" }))
    await act(async () => {})
    expect(executeMock).not.toHaveBeenCalled()
  })

  it("names the source app alone when the window has no title", async () => {
    currentMock.mockResolvedValue({ ...candidate, sourceTitle: undefined })
    render(<SelectionToolbarView />)
    await act(async () => {})
    expect(screen.getByTestId("selection-toolbar")).toHaveAttribute("title", "TextEdit")
  })

  it("names the app and window together when both are known", async () => {
    render(<SelectionToolbarView />)
    await act(async () => {})
    expect(screen.getByTestId("selection-toolbar")).toHaveAttribute("title", "TextEdit · Draft")
  })

  it("renders nothing at all with no candidate", async () => {
    currentMock.mockResolvedValue(null)
    render(<SelectionToolbarView />)
    await act(async () => {})
    expect(screen.queryByTestId("selection-toolbar-capsule")).not.toBeInTheDocument()
    expect(revealMock).not.toHaveBeenCalled()
  })

  it("makes the window focusable only while the language list is open", async () => {
    render(<SelectionToolbarView />)
    await act(async () => {})
    interactiveMock.mockClear()
    fireEvent.click(within(capsule()).getByRole("button", { name: "chooseLanguage" }))
    await waitFor(() => expect(interactiveMock).toHaveBeenCalledWith(true))
  })

  it("ignores a chord that maps to no action", async () => {
    render(<SelectionToolbarView />)
    await act(async () => {})
    await emit("selection://shortcut", {
      shortcutId: "selection.captureClipboard",
      candidateId: "candidate-1",
    })
    expect(executeMock).not.toHaveBeenCalled()
  })

  it("ignores playback updates addressed to another candidate", async () => {
    render(<SelectionToolbarView />)
    await act(async () => {})
    await emit("selection://speech", { candidateId: "other", playing: true, progress: 0.9 })
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
  })

  it("does nothing on stop when the candidate has already gone", async () => {
    currentMock.mockResolvedValue(null)
    render(<SelectionToolbarView />)
    await act(async () => {})
    expect(emitToMock).not.toHaveBeenCalled()
  })

  it("closes only the language list on Escape, leaving the toolbar up", async () => {
    render(<SelectionToolbarView />)
    await act(async () => {})
    fireEvent.click(within(capsule()).getByRole("button", { name: "chooseLanguage" }))
    await act(async () => {})
    expect(screen.getByRole("listbox")).toBeInTheDocument()

    await emit("selection://escape", null)
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
    // Still on screen: a second Escape reaches Rust, which dismisses.
    expect(capsule()).toBeInTheDocument()
    await waitFor(() => expect(interactiveMock).toHaveBeenLastCalledWith(false))
  })

  it("disposes listeners that resolve after unmount, instead of leaking them", async () => {
    const disposers: jest.Mock[] = []
    const { listen } = jest.requireMock("@tauri-apps/api/event") as {
      listen: (event: string, handler: unknown) => Promise<unknown>
    }
    let releaseListen: (() => void) | null = null
    const gated = new Promise<void>((resolve) => {
      releaseListen = resolve
    })
    const original = listen
    ;(jest.requireMock("@tauri-apps/api/event") as Record<string, unknown>).listen = async (
      event: string,
      handler: unknown
    ) => {
      await original(event, handler)
      await gated
      const dispose = jest.fn()
      disposers.push(dispose)
      return dispose
    }

    const { unmount } = render(<SelectionToolbarView />)
    unmount()
    await act(async () => {
      releaseListen?.()
    })

    expect(disposers.length).toBeGreaterThan(0)
    for (const dispose of disposers) expect(dispose).toHaveBeenCalled()
    ;(jest.requireMock("@tauri-apps/api/event") as Record<string, unknown>).listen = original
  })

  it("disposes the per-candidate listeners too when unmounted mid-subscribe", async () => {
    const disposers: jest.Mock[] = []
    const events = jest.requireMock("@tauri-apps/api/event") as Record<string, unknown>
    const original = events.listen as (event: string, handler: unknown) => Promise<unknown>
    let gate: Promise<void> = Promise.resolve()

    events.listen = async (event: string, handler: unknown) => {
      await original(event, handler)
      await gate
      const dispose = jest.fn()
      disposers.push(dispose)
      return dispose
    }

    const { unmount } = render(<SelectionToolbarView />)
    // Let the candidate land so the per-candidate effect subscribes...
    await act(async () => {})
    let release: (() => void) | null = null
    gate = new Promise<void>((resolve) => {
      release = resolve
    })
    disposers.length = 0
    await emit("selection://candidate", { ...candidate, id: "candidate-9" })

    unmount()
    await act(async () => {
      release?.()
    })

    expect(disposers.length).toBeGreaterThan(0)
    for (const dispose of disposers) expect(dispose).toHaveBeenCalled()
    events.listen = original
  })
})

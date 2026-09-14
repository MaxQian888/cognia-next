/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { UIMessage } from "ai"

import enChat from "@/i18n/messages/en/chat.json"
import zhChat from "@/i18n/messages/zh-CN/chat.json"
import type { SelectionRunRequest, SelectionRunState } from "@/hooks/chat/use-selection-action-run"
import { selectComposerContextSelections, useChatStore } from "@/stores/chat/chat-store"
import { useProjectStore } from "@/stores/project/project-store"
import { TranscriptSelectionBar } from "./transcript-selection-bar"

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

let runState: SelectionRunState = { status: "idle" }
const mockStart = jest.fn()
const mockStop = jest.fn()
const mockClose = jest.fn()
jest.mock("@/hooks/chat/use-selection-action-run", () => ({
  useSelectionActionRun: () => ({
    state: runState,
    run: mockStart,
    stop: mockStop,
    close: mockClose,
  }),
}))

// The answer panel has its own suite; this one checks what the bar hands it.
jest.mock("@/components/chat/message-selection-result-panel", () => ({
  MessageSelectionResultPanel: (props: {
    sourceLabel?: string
    onReference: (text: string) => void
    onClose: () => void
  }) => (
    <div data-testid="result-panel" data-source={props.sourceLabel}>
      <button type="button" onClick={() => props.onReference("The summary.")}>
        reference-summary
      </button>
    </div>
  ),
}))

const mockCopy = jest.fn()
jest.mock("@/hooks/ui/use-copy", () => ({
  useCopy: () => ({ copied: false, isCopying: false, copy: mockCopy }),
}))

const mockBuildSet = jest.fn()
jest.mock("@/lib/chat/selection/message-set-reference", () => ({
  buildMessageSetReference: (input: unknown) => mockBuildSet(input),
}))
const mockBuildExcerpt = jest.fn()
jest.mock("@/lib/chat/selection/message-excerpt", () => ({
  buildMessageExcerptSelection: (input: unknown) => mockBuildExcerpt(input),
}))
const mockSaveMemory = jest.fn()
jest.mock("@/lib/chat/save-message-as-memory", () => ({
  saveMessagesAsMemory: (input: unknown) => mockSaveMemory(input),
}))

// The bar reads whether it is still present or animating out after the mode
// ended; jsdom runs no exit animation, so a test sets it directly.
let mockPresent = true
jest.mock("motion/react", () => ({
  ...jest.requireActual("motion/react"),
  useIsPresent: () => mockPresent,
}))

const copy = enChat.transcriptSelection

function msg(id: string, role: UIMessage["role"], text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] } as UIMessage
}

const MESSAGES = [msg("m1", "user", "Why is CI red?"), msg("m2", "assistant", "Lint fails.")]

function setup(over: Partial<Parameters<typeof TranscriptSelectionBar>[0]> = {}) {
  const props = {
    sessionId: "s1",
    messages: MESSAGES,
    selectableCount: 5,
    onSelectAll: jest.fn(),
    onClear: jest.fn(),
    onExit: jest.fn(),
    ...over,
  }
  const view = render(<TranscriptSelectionBar {...props} />)
  return { ...props, ...view }
}

const staged = () => selectComposerContextSelections(useChatStore.getState(), "s1")

beforeEach(() => {
  jest.clearAllMocks()
  runState = { status: "idle" }
  mockPresent = true
  act(() => useChatStore.getState().clear())
  useProjectStore.setState({ activeProjectId: "p1" } as never)
})

describe("TranscriptSelectionBar", () => {
  it("says how many are ticked and names every action", () => {
    setup()
    expect(screen.getByTestId("transcript-selection-count")).toHaveTextContent("2 selected")
    for (const label of [
      copy.actions.reference,
      copy.actions.summarize,
      copy.actions.copy,
      copy.actions.saveMemory,
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeEnabled()
    }
    expect(screen.getByRole("toolbar", { name: copy.toolbarLabel })).toBeInTheDocument()
  })

  // Leaving is the first thing on the bar, not the last thing past four actions.
  it("puts the way out first", () => {
    setup()
    const buttons = screen.getAllByRole("button")
    expect(buttons[0]).toBe(screen.getByTestId("transcript-selection-exit"))
    expect(buttons[0]).toHaveAccessibleName(copy.exit)
  })

  it("offers no action with nothing ticked", () => {
    setup({ messages: [] })
    expect(screen.getByTestId("transcript-selection-count")).toHaveTextContent(
      "No messages selected"
    )
    expect(screen.getByTestId("transcript-selection-reference")).toBeDisabled()
    expect(screen.getByTestId("transcript-selection-summarize")).toBeDisabled()
  })

  it("toggles between selecting everything and clearing", () => {
    const first = setup()
    fireEvent.click(screen.getByTestId("transcript-selection-all"))
    expect(first.onSelectAll).toHaveBeenCalled()
    first.unmount()
    const all = setup({ selectableCount: 2 })
    expect(screen.getByTestId("transcript-selection-all")).toHaveTextContent(copy.clear)
    fireEvent.click(screen.getByTestId("transcript-selection-all"))
    expect(all.onClear).toHaveBeenCalled()
  })

  describe("Reference", () => {
    it("stages the ticked messages as one reference into this conversation, then ends the mode", async () => {
      const selection = {
        kind: "entity",
        entityKind: "message",
        entityId: "s1#m1",
        title: "user: Why is CI red?",
        snapshot: "body",
        comment: "",
        capturedAt: 1,
        members: [
          { entityId: "s1#m1", title: "a" },
          { entityId: "s1#m2", title: "b" },
        ],
      }
      mockBuildSet.mockResolvedValue(selection)
      const { onExit } = setup()
      fireEvent.click(screen.getByTestId("transcript-selection-reference"))
      await waitFor(() => expect(onExit).toHaveBeenCalled())
      expect(mockBuildSet).toHaveBeenCalledWith({ sessionId: "s1", messageIds: ["m1", "m2"] })
      expect(staged()).toEqual([selection])
      expect(toastSuccess).toHaveBeenCalledWith(
        "Added 2 messages to the composer as one reference."
      )
    })

    it("says so and stays in the mode when nothing could be read", async () => {
      mockBuildSet.mockResolvedValue(null)
      const { onExit } = setup()
      fireEvent.click(screen.getByTestId("transcript-selection-reference"))
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(copy.referenceEmpty))
      expect(onExit).not.toHaveBeenCalled()
      expect(staged()).toHaveLength(0)
    })

    // A double click must not stage twice.
    it("runs once while a reference is being built", async () => {
      let resolve: (value: unknown) => void = () => {}
      mockBuildSet.mockReturnValue(new Promise((r) => (resolve = r)))
      setup()
      fireEvent.click(screen.getByTestId("transcript-selection-reference"))
      fireEvent.click(screen.getByTestId("transcript-selection-reference"))
      await act(async () => resolve(null))
      expect(mockBuildSet).toHaveBeenCalledTimes(1)
    })
  })

  describe("Summarize", () => {
    it("summarizes from one labelled segment per message", () => {
      setup()
      fireEvent.click(screen.getByTestId("transcript-selection-summarize"))
      expect(mockStart).toHaveBeenCalledWith({
        action: "summarize",
        quote: "Why is CI red?\nLint fails.",
        segments: ["user: Why is CI red?", "assistant: Lint fails."],
        sessionId: "s1",
        messageIds: ["m1", "m2"],
        context: "",
      })
    })

    it("shows the answer, and references it as a summary of those messages", async () => {
      const request: SelectionRunRequest = {
        action: "summarize",
        quote: "Why is CI red?\nLint fails.",
        segments: [],
        sessionId: "s1",
        messageIds: ["m1", "m2"],
        context: "",
      }
      runState = { status: "done", request, text: "The summary.", parts: 1 }
      const summary = {
        kind: "entity",
        entityKind: "message",
        entityId: "s1#m1",
        title: "t",
        snapshot: "The summary.",
        comment: "",
        capturedAt: 1,
      }
      mockBuildExcerpt.mockResolvedValue(summary)
      const { onExit } = setup()
      expect(screen.getByTestId("result-panel")).toHaveAttribute(
        "data-source",
        "From 2 selected messages"
      )

      fireEvent.click(screen.getByRole("button", { name: "reference-summary" }))
      await waitFor(() => expect(onExit).toHaveBeenCalled())
      expect(mockBuildExcerpt).toHaveBeenCalledWith({
        sessionId: "s1",
        messageIds: ["m1", "m2"],
        text: "The summary.",
        excerpt: { derivation: "summary", quote: "Why is CI red?\nLint fails." },
      })
      expect(staged()).toEqual([summary])
      expect(mockClose).toHaveBeenCalled()
    })
  })

  describe("Copy", () => {
    it("copies each message under who said it, then ends the mode", async () => {
      mockCopy.mockResolvedValue(true)
      const { onExit } = setup()
      fireEvent.click(screen.getByTestId("transcript-selection-copy"))
      await waitFor(() => expect(onExit).toHaveBeenCalled())
      expect(mockCopy).toHaveBeenCalledWith("You:\nWhy is CI red?\n\nAssistant:\nLint fails.")
      expect(toastSuccess).toHaveBeenCalledWith("Copied 2 messages.")
    })

    it("says so when the clipboard refuses", async () => {
      mockCopy.mockResolvedValue(false)
      const { onExit } = setup()
      fireEvent.click(screen.getByTestId("transcript-selection-copy"))
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(copy.copyFailed))
      expect(onExit).not.toHaveBeenCalled()
    })
  })

  describe("Save as memory", () => {
    it("files one draft for the ticked messages in the active workspace", async () => {
      mockSaveMemory.mockResolvedValue("Why is CI red?")
      const { onExit } = setup()
      fireEvent.click(screen.getByTestId("transcript-selection-saveMemory"))
      await waitFor(() => expect(onExit).toHaveBeenCalled())
      expect(mockSaveMemory).toHaveBeenCalledWith({
        messages: MESSAGES,
        sessionId: "s1",
        projectId: "p1",
      })
      expect(toastSuccess).toHaveBeenCalledWith("Saved a memory draft: “Why is CI red?”")
    })

    it("shows a refusal and keeps the mode", async () => {
      mockSaveMemory.mockRejectedValue(new Error("contains an email address"))
      const { onExit } = setup()
      fireEvent.click(screen.getByTestId("transcript-selection-saveMemory"))
      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          "Couldn't save as memory: contains an email address"
        )
      )
      expect(onExit).not.toHaveBeenCalled()
    })

    it("says so when there is nothing to keep", async () => {
      mockSaveMemory.mockResolvedValue(null)
      setup()
      fireEvent.click(screen.getByTestId("transcript-selection-saveMemory"))
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(copy.memoryEmpty))
    })
  })

  describe("keys", () => {
    it("ends the mode on Esc", () => {
      const { onExit } = setup()
      fireEvent.keyDown(window, { key: "Escape" })
      expect(onExit).toHaveBeenCalled()
    })

    it("closes an open answer first, and only that", () => {
      runState = {
        status: "running",
        request: {
          action: "summarize",
          quote: "q",
          sessionId: "s1",
          messageIds: ["m1"],
          context: "",
        },
        text: "",
        progress: null,
      }
      const { onExit } = setup()
      fireEvent.keyDown(document.body, { key: "Escape" })
      expect(mockClose).toHaveBeenCalled()
      expect(onExit).not.toHaveBeenCalled()
    })

    it("ticks everything on ⌘A and Ctrl+A", () => {
      const { onSelectAll } = setup()
      fireEvent.keyDown(document.body, { key: "a", metaKey: true })
      fireEvent.keyDown(document.body, { key: "A", ctrlKey: true })
      expect(onSelectAll).toHaveBeenCalledTimes(2)
    })

    // Both keys already mean something in a field being typed into.
    it("leaves both keys to a field being typed into", () => {
      const { onExit, onSelectAll } = setup()
      const field = document.createElement("textarea")
      field.value = "half a sentence"
      document.body.appendChild(field)
      fireEvent.keyDown(field, { key: "Escape" })
      fireEvent.keyDown(field, { key: "a", metaKey: true })
      expect(onExit).not.toHaveBeenCalled()
      expect(onSelectAll).not.toHaveBeenCalled()
      field.remove()
    })

    // Focus sits in the composer by habit. With nothing typed there, Esc has
    // nothing else to mean, and refusing it left no keyboard way out.
    it("ends the mode on Esc from an empty field, but leaves ⌘A to it", () => {
      const { onExit, onSelectAll } = setup()
      const field = document.createElement("textarea")
      document.body.appendChild(field)
      fireEvent.keyDown(field, { key: "a", metaKey: true })
      expect(onSelectAll).not.toHaveBeenCalled()
      fireEvent.keyDown(field, { key: "Escape" })
      expect(onExit).toHaveBeenCalledTimes(1)
      field.remove()
    })

    it("acts on nothing while it animates out", () => {
      mockPresent = false
      const { onExit, onSelectAll } = setup()
      fireEvent.keyDown(window, { key: "a", metaKey: true })
      fireEvent.keyDown(window, { key: "Escape" })
      expect(onSelectAll).not.toHaveBeenCalled()
      expect(onExit).not.toHaveBeenCalled()
      expect(screen.getByTestId("transcript-selection-reference")).toBeDisabled()
      expect(screen.getByTestId("transcript-selection-exit")).toBeDisabled()
    })

    it("leaves an Esc another layer already handled", () => {
      const { onExit } = setup()
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      event.preventDefault()
      window.dispatchEvent(event)
      expect(onExit).not.toHaveBeenCalled()
    })

    it("stops listening once the mode ends", () => {
      const { onExit, unmount } = setup()
      unmount()
      fireEvent.keyDown(window, { key: "Escape" })
      expect(onExit).not.toHaveBeenCalled()
    })
  })

  it("exits from its own button", () => {
    const { onExit } = setup()
    fireEvent.click(screen.getByRole("button", { name: copy.exit }))
    expect(onExit).toHaveBeenCalled()
  })

  // The count and the source title are plural ICU messages, which `lint:i18n`
  // parity alone does not exercise.
  it("has every string in both catalogues", () => {
    for (const catalogue of [enChat, zhChat]) {
      const block = catalogue.transcriptSelection
      for (const key of ["copy", "reference", "saveMemory", "summarize"] as const) {
        expect(block.actions[key]).toEqual(expect.any(String))
      }
      for (const key of ["assistant", "system", "user"] as const) {
        expect(block.speaker[key]).toEqual(expect.any(String))
      }
    }
  })
})

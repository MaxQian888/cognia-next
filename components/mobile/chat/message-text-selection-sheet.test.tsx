/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { UIMessage } from "ai"

import enChat from "@/i18n/messages/en/chat.json"
import enSheet from "@/i18n/messages/en/mobile/messageTextSelection.json"
import type { SelectionRunState } from "@/hooks/chat/use-selection-action-run"
import { composeTurnText } from "@/lib/chat/prompt-preamble"
import { selectComposerContextSelections, useChatStore } from "@/stores/chat/chat-store"
import { MessageTextSelectionSheet } from "./message-text-selection-sheet"

const mockActions = {
  run: { status: "idle" } as SelectionRunState,
  start: jest.fn(),
  retry: jest.fn(),
  stop: jest.fn(),
  close: jest.fn(),
  targetLocale: "en",
  chooseLocale: jest.fn(),
  languageLabel: (tag: string | undefined) => tag,
  referencePassage: jest.fn(async () => true),
  referenceResult: jest.fn(async () => true),
  referencing: false,
}
jest.mock("@/hooks/chat/use-message-selection-actions", () => ({
  useMessageSelectionActions: () => mockActions,
}))

const mockBuildSet = jest.fn()
jest.mock("@/lib/chat/selection/message-set-reference", () => ({
  buildMessageSetReference: (input: unknown) => mockBuildSet(input),
}))

jest.mock("@/lib/capacitor/haptics", () => ({ selectionFeedback: jest.fn() }))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

// The answer panel has its own suite; here only what the sheet hands it.
jest.mock("@/components/chat/message-selection-result-panel", () => ({
  MessageSelectionResultPanel: (props: {
    sourceLabel?: string
    onReference: (text: string) => void
  }) => (
    <div data-testid="result-panel" data-source={props.sourceLabel ?? "(selection)"}>
      <button type="button" onClick={() => props.onReference("The answer.")}>
        reference-answer
      </button>
    </div>
  ),
}))

// Radix's radio group does not route a jsdom click to `onValueChange`; reduced
// to items that report their value, as in the capsule's suite.
jest.mock("@/components/ui/dropdown-menu", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  const Group = React.createContext<(value: string) => void>(() => undefined)
  const pass = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children)
  return {
    DropdownMenu: pass,
    DropdownMenuTrigger: pass,
    DropdownMenuContent: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", { role: "menu" }, children),
    DropdownMenuLabel: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children),
    DropdownMenuRadioGroup: ({
      children,
      onValueChange,
    }: {
      children?: React.ReactNode
      onValueChange: (value: string) => void
    }) => React.createElement(Group.Provider, { value: onValueChange }, children),
    DropdownMenuRadioItem: function RadioItem({
      children,
      value,
    }: {
      children?: React.ReactNode
      value: string
    }) {
      const change = React.useContext(Group)
      return React.createElement(
        "button",
        { type: "button", role: "menuitemradio", onClick: () => change(value) },
        children
      )
    },
  }
})

const copy = enChat.selection
const WORDS = "Pin the lockfile, then rerun the job."

function message(text = WORDS): UIMessage {
  return { id: "m1", role: "assistant", parts: [{ type: "text", text }] } as UIMessage
}

function setup(msg: UIMessage | null = message(), sessionId: string | null = "s1") {
  const onOpenChange = jest.fn()
  const view = render(
    <MessageTextSelectionSheet message={msg} sessionId={sessionId} onOpenChange={onOpenChange} />
  )
  return { onOpenChange, ...view }
}

const textBox = () => screen.getByTestId("message-text-selection-text")
const scope = () => screen.getByTestId("message-text-selection-scope")

/** Select `[start, end)` of the sheet's text, as the system's handles would. */
function selectWords(start: number, end: number) {
  const node = textBox().firstChild!
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  act(() => {
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event("selectionchange"))
  })
}

function collapseSelection() {
  act(() => {
    window.getSelection()!.removeAllRanges()
    document.dispatchEvent(new Event("selectionchange"))
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockActions.run = { status: "idle" }
  mockActions.referencePassage.mockResolvedValue(true)
  mockActions.referenceResult.mockResolvedValue(true)
  window.getSelection()?.removeAllRanges()
  act(() => useChatStore.getState().clear())
})

describe("MessageTextSelectionSheet", () => {
  it("is closed without a message or a conversation", () => {
    setup(null)
    expect(screen.queryByTestId("message-text-selection-sheet")).toBeNull()
    setup(message(), null)
    expect(screen.queryByTestId("message-text-selection-sheet")).toBeNull()
  })

  it("lays out the words without the context envelope the turn was sent with", () => {
    const { text } = composeTurnText("compare these", [{ kind: "references", text: "SECRET" }], {
      nonce: "abcdef1234",
    })
    setup(message(text))
    expect(textBox()).toHaveTextContent("compare these")
    expect(textBox()).not.toHaveTextContent("SECRET")
    expect(screen.getByText(enSheet.title)).toBeInTheDocument()
  })

  describe("with nothing selected", () => {
    it("says the actions take the whole message", () => {
      setup()
      expect(scope()).toHaveTextContent(enSheet.scopeMessage)
      expect(screen.queryByTestId("message-text-selection-clear")).toBeNull()
    })

    // All of one message is the chip `@msg:` stages, not an excerpt of it.
    it("references the whole message as a message reference, and closes", async () => {
      mockBuildSet.mockResolvedValue({
        kind: "entity",
        entityKind: "message",
        entityId: "s1#m1",
        title: "assistant: Pin the lockfile",
        snapshot: WORDS,
        comment: "",
        capturedAt: 1,
      })
      const { onOpenChange } = setup()
      fireEvent.click(screen.getByTestId("message-text-selection-reference"))
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
      expect(mockBuildSet).toHaveBeenCalledWith({ sessionId: "s1", messageIds: ["m1"] })
      expect(mockActions.referencePassage).not.toHaveBeenCalled()
      expect(selectComposerContextSelections(useChatStore.getState(), "s1")).toHaveLength(1)
      expect(toastSuccess).toHaveBeenCalledWith(
        copy.referenced.replace("{title}", "assistant: Pin the lockfile")
      )
    })

    it("stays open and says so when the message cannot be read", async () => {
      mockBuildSet.mockResolvedValue(null)
      const { onOpenChange } = setup()
      fireEvent.click(screen.getByTestId("message-text-selection-reference"))
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(copy.referenceError))
      expect(onOpenChange).not.toHaveBeenCalled()
    })

    it("summarizes the whole message, and the answer says where it came from", () => {
      const { rerender, onOpenChange } = setup()
      fireEvent.click(screen.getByTestId("message-text-selection-summarize"))
      expect(mockActions.start).toHaveBeenCalledWith(
        "summarize",
        { text: WORDS, messageIds: ["m1"], context: WORDS },
        undefined
      )
      mockActions.run = {
        status: "done",
        request: {
          action: "summarize",
          quote: WORDS,
          sessionId: "s1",
          messageIds: ["m1"],
          context: WORDS,
        },
        text: "Pin it.",
        parts: 1,
      }
      rerender(
        <MessageTextSelectionSheet message={message()} sessionId="s1" onOpenChange={onOpenChange} />
      )
      expect(screen.getByTestId("result-panel")).toHaveAttribute(
        "data-source",
        enSheet.sourceMessage
      )
      expect(screen.queryByRole("toolbar")).toBeNull()
    })
  })

  describe("with part of the message selected", () => {
    const PART = "Pin the lockfile"

    it("names the passage and references it as a quote", async () => {
      const { onOpenChange } = setup()
      selectWords(0, PART.length)
      expect(scope()).toHaveTextContent(enSheet.scopeSelection.replace("{title}", PART))
      fireEvent.click(screen.getByTestId("message-text-selection-reference"))
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
      expect(mockActions.referencePassage).toHaveBeenCalledWith({
        text: PART,
        messageIds: ["m1"],
        context: WORDS,
      })
      expect(mockBuildSet).not.toHaveBeenCalled()
    })

    it("stays open when the passage could not be staged", async () => {
      mockActions.referencePassage.mockResolvedValue(false)
      const { onOpenChange } = setup()
      selectWords(0, PART.length)
      fireEvent.click(screen.getByTestId("message-text-selection-reference"))
      await waitFor(() => expect(mockActions.referencePassage).toHaveBeenCalled())
      expect(onOpenChange).not.toHaveBeenCalled()
    })

    // Touching a button collapses the system selection before its click lands.
    it("keeps the passage through the collapse a press on the bar causes", () => {
      setup()
      selectWords(0, PART.length)
      const summarize = screen.getByTestId("message-text-selection-summarize")
      fireEvent.pointerDown(summarize)
      collapseSelection()
      expect(scope()).toHaveTextContent(PART)
      fireEvent.click(summarize)
      expect(mockActions.start).toHaveBeenCalledWith(
        "summarize",
        { text: PART, messageIds: ["m1"], context: WORDS },
        undefined
      )
    })

    it("lets the passage go when the selection is dropped anywhere else", () => {
      setup()
      selectWords(0, PART.length)
      fireEvent.pointerDown(textBox())
      collapseSelection()
      expect(scope()).toHaveTextContent(enSheet.scopeMessage)
    })

    it("goes back to the whole message on request", () => {
      setup()
      selectWords(0, PART.length)
      fireEvent.click(screen.getByTestId("message-text-selection-clear"))
      expect(scope()).toHaveTextContent(enSheet.scopeMessage)
      expect(window.getSelection()!.isCollapsed).toBe(true)
    })

    it("ignores a selection too short to be deliberate", () => {
      setup()
      selectWords(0, 1)
      expect(scope()).toHaveTextContent(enSheet.scopeMessage)
    })

    it("translates the passage into the language picked, remembering it", () => {
      setup()
      selectWords(0, PART.length)
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Japanese" }))
      expect(mockActions.chooseLocale).toHaveBeenCalledWith("ja")
      expect(mockActions.start).toHaveBeenCalledWith(
        "translate",
        { text: PART, messageIds: ["m1"], context: WORDS },
        "ja"
      )
    })
  })

  it("references an answer and closes once it is staged", async () => {
    mockActions.run = {
      status: "done",
      request: { action: "explain", quote: WORDS, sessionId: "s1", messageIds: ["m1"], context: "" },
      text: "The answer.",
      parts: 1,
    }
    const { onOpenChange } = setup()
    fireEvent.click(screen.getByRole("button", { name: "reference-answer" }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(mockActions.referenceResult).toHaveBeenCalledWith("The answer.")
  })

  it("offers no aside, which a phone has nowhere to show", () => {
    setup()
    expect(screen.queryByText(copy.askInAside)).toBeNull()
  })
})

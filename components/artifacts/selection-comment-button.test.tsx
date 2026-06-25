/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { SelectionCommentButton, locateSelectionRange } from "./selection-comment-button"
import { useChatStore } from "@/stores/chat"
import type { Artifact } from "@/types"

const artifact: Artifact = {
  id: "art1",
  sessionId: "s1",
  messageId: "m1",
  type: "code",
  title: "Snippet",
  content: "line one\nline two\nline three",
  language: "javascript",
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
}

function setSelection(text: string) {
  // jsdom's window.getSelection exists but isn't tied to rendered nodes; stub it.
  Object.defineProperty(window, "getSelection", {
    configurable: true,
    value: () => ({ toString: () => text }),
  })
}

beforeEach(() => {
  act(() => useChatStore.getState().clear())
  setSelection("")
})

describe("locateSelectionRange", () => {
  it("computes 1-based line range for a matched snippet", () => {
    expect(locateSelectionRange("a\nb\nc\nd", "b\nc")).toEqual({ startLine: 2, endLine: 3 })
  })

  it("falls back to line 1 when the snippet is not found", () => {
    expect(locateSelectionRange("a\nb", "zzz")).toEqual({ startLine: 1, endLine: 1 })
  })
})

describe("SelectionCommentButton", () => {
  it("stages a selection + comment into the chat store", () => {
    setSelection("line two")
    render(<SelectionCommentButton artifact={artifact} />)

    const trigger = screen.getByTestId("selection-comment-trigger")
    // mousedown captures the selection; click opens the popover.
    fireEvent.mouseDown(trigger)
    fireEvent.click(trigger)

    const textarea = screen.getByPlaceholderText("selectionCommentPlaceholder")
    fireEvent.change(textarea, { target: { value: "make it const" } })
    fireEvent.click(screen.getByText("addToChat"))

    const selections = useChatStore.getState().artifactSelections
    expect(selections).toHaveLength(1)
    expect(selections[0]).toMatchObject({
      artifactId: "art1",
      snapshot: "line two",
      comment: "make it const",
      range: { startLine: 2, endLine: 2 },
    })
  })

  it("disables 'add to chat' when there is no selection", () => {
    setSelection("")
    render(<SelectionCommentButton artifact={artifact} />)
    const trigger = screen.getByTestId("selection-comment-trigger")
    fireEvent.mouseDown(trigger)
    fireEvent.click(trigger)
    expect(screen.getByText("addToChat").closest("button")!).toBeDisabled()
    expect(useChatStore.getState().artifactSelections).toHaveLength(0)
  })
})

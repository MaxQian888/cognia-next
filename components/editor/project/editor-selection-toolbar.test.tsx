/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

import {
  EditorSelectionToolbar,
  placeSelectionToolbar,
  type SelectionToolbarEditor,
} from "./editor-selection-toolbar"

type Listener = () => void
type EventName = "selection" | "scroll" | "layout" | "focus" | "blur" | "mouseDown" | "mouseUp"

interface FakeState {
  focused: boolean
  empty: boolean
  start: { lineNumber: number; column: number }
  end: { lineNumber: number; column: number }
  width: number
  height: number
  /** Visible top per line number; missing = scrolled out of view. */
  lineTops: Record<number, number>
  /** Visible left per column. */
  leftPerColumn: number
}

function fakeEditor(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    focused: true,
    empty: false,
    start: { lineNumber: 10, column: 5 },
    end: { lineNumber: 12, column: 3 },
    width: 800,
    height: 400,
    lineTops: { 10: 200, 12: 240 },
    leftPerColumn: 10,
    ...overrides,
  }
  const listeners = new Map<EventName, Set<Listener>>()
  const on = (name: EventName) => (listener: Listener) => {
    const set = listeners.get(name) ?? new Set()
    set.add(listener)
    listeners.set(name, set)
    return { dispose: () => set.delete(listener) }
  }
  const editor: SelectionToolbarEditor = {
    getSelection: () => ({
      isEmpty: () => state.empty,
      getStartPosition: () => state.start,
      getEndPosition: () => state.end,
    }),
    getScrolledVisiblePosition: (position) => {
      const top = state.lineTops[position.lineNumber]
      if (top === undefined) return null
      return { top, left: position.column * state.leftPerColumn, height: 20 }
    },
    getLayoutInfo: () => ({ width: state.width, height: state.height }),
    hasTextFocus: () => state.focused,
    onDidChangeCursorSelection: on("selection"),
    onDidScrollChange: on("scroll"),
    onDidLayoutChange: on("layout"),
    onDidFocusEditorText: on("focus"),
    onDidBlurEditorText: on("blur"),
    onMouseDown: on("mouseDown"),
    onMouseUp: on("mouseUp"),
  }
  const emit = (name: EventName) =>
    act(() => {
      for (const listener of listeners.get(name) ?? []) listener()
    })
  const listenerCount = () =>
    Array.from(listeners.values()).reduce((count, set) => count + set.size, 0)
  return { editor, state, emit, listenerCount }
}

describe("placeSelectionToolbar", () => {
  it("sits above the selection's first line", () => {
    const { editor } = fakeEditor()
    // 200 − 6 gap − 36 height; column 5 × 10px.
    expect(placeSelectionToolbar(editor)).toEqual({ top: 158, left: 50 })
  })

  it("drops below the last line when the first is scrolled away", () => {
    const { editor } = fakeEditor({ lineTops: { 12: 240 } })
    // 240 + 20 line height + 6 gap; column 3 × 10px.
    expect(placeSelectionToolbar(editor)).toEqual({ top: 266, left: 30 })
  })

  it("drops below the first line when it hugs the top edge and the last is off screen", () => {
    const { editor } = fakeEditor({ lineTops: { 10: 10 } })
    expect(placeSelectionToolbar(editor)).toEqual({ top: 36, left: 50 })
  })

  it("overlaps the last line rather than leaving the editor at its bottom edge", () => {
    const { editor } = fakeEditor({ lineTops: { 12: 390 } })
    expect(placeSelectionToolbar(editor)?.top).toBe(400 - 36 - 4)
  })

  it("keeps clear of the right edge and the left edge", () => {
    const right = fakeEditor({ leftPerColumn: 200 })
    expect(placeSelectionToolbar(right.editor)?.left).toBe(800 - 260)
    const narrow = fakeEditor({ width: 100 })
    expect(placeSelectionToolbar(narrow.editor)?.left).toBe(4)
  })

  it("hides without focus, without a selection, or with the selection off screen", () => {
    expect(placeSelectionToolbar(fakeEditor({ focused: false }).editor)).toBeNull()
    expect(placeSelectionToolbar(fakeEditor({ empty: true }).editor)).toBeNull()
    expect(placeSelectionToolbar(fakeEditor({ lineTops: {} }).editor)).toBeNull()
    expect(placeSelectionToolbar(fakeEditor({ lineTops: { 10: 500, 12: -40 } }).editor)).toBeNull()
  })
})

describe("EditorSelectionToolbar", () => {
  it("shows over a selection and runs each action", () => {
    const { editor } = fakeEditor()
    const actions = { onAddToChat: jest.fn(), onAskAi: jest.fn(), onComment: jest.fn() }
    render(<EditorSelectionToolbar editor={editor} actions={actions} />)

    const toolbar = screen.getByTestId("editor-selection-toolbar")
    expect(toolbar).toHaveAttribute("role", "toolbar")
    expect(toolbar).toHaveAttribute("aria-label", "aria")
    expect(toolbar.style.top).toBe("158px")
    expect(toolbar.style.left).toBe("50px")

    fireEvent.click(screen.getByTestId("editor-selection-add-to-chat"))
    fireEvent.click(screen.getByTestId("editor-selection-ask-ai"))
    fireEvent.click(screen.getByTestId("editor-selection-comment"))
    expect(actions.onAddToChat).toHaveBeenCalledTimes(1)
    expect(actions.onAskAi).toHaveBeenCalledTimes(1)
    expect(actions.onComment).toHaveBeenCalledTimes(1)
  })

  it("omits the buttons whose action the host did not supply", () => {
    const { editor } = fakeEditor()
    render(<EditorSelectionToolbar editor={editor} actions={{ onAddToChat: jest.fn() }} />)
    expect(screen.getByTestId("editor-selection-add-to-chat")).toBeInTheDocument()
    expect(screen.queryByTestId("editor-selection-ask-ai")).not.toBeInTheDocument()
    expect(screen.queryByTestId("editor-selection-comment")).not.toBeInTheDocument()
  })

  it("keeps the editor focused through a click on the toolbar", () => {
    const { editor } = fakeEditor()
    render(<EditorSelectionToolbar editor={editor} actions={{ onAddToChat: jest.fn() }} />)
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    screen.getByTestId("editor-selection-add-to-chat").dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it("follows the selection, scroll and focus", () => {
    const { editor, state, emit } = fakeEditor({ empty: true })
    render(<EditorSelectionToolbar editor={editor} actions={{ onAddToChat: jest.fn() }} />)
    expect(screen.queryByTestId("editor-selection-toolbar")).not.toBeInTheDocument()

    state.empty = false
    emit("selection")
    expect(screen.getByTestId("editor-selection-toolbar").style.top).toBe("158px")

    state.lineTops = { 10: 100, 12: 140 }
    emit("scroll")
    expect(screen.getByTestId("editor-selection-toolbar").style.top).toBe("58px")

    state.focused = false
    emit("blur")
    expect(screen.queryByTestId("editor-selection-toolbar")).not.toBeInTheDocument()
    state.focused = true
    emit("focus")
    expect(screen.getByTestId("editor-selection-toolbar")).toBeInTheDocument()
  })

  it("stays hidden while a mouse drag is still extending the selection", () => {
    const { editor, emit } = fakeEditor()
    render(<EditorSelectionToolbar editor={editor} actions={{ onAddToChat: jest.fn() }} />)

    emit("mouseDown")
    emit("selection")
    expect(screen.queryByTestId("editor-selection-toolbar")).not.toBeInTheDocument()
    emit("mouseUp")
    expect(screen.getByTestId("editor-selection-toolbar")).toBeInTheDocument()

    // A drag released outside the editor ends on the window.
    emit("mouseDown")
    expect(screen.queryByTestId("editor-selection-toolbar")).not.toBeInTheDocument()
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"))
    })
    expect(screen.getByTestId("editor-selection-toolbar")).toBeInTheDocument()
  })

  it("disposes every editor subscription on unmount", () => {
    const { editor, listenerCount } = fakeEditor()
    const { unmount } = render(
      <EditorSelectionToolbar editor={editor} actions={{ onAddToChat: jest.fn() }} />
    )
    expect(listenerCount()).toBe(7)
    unmount()
    expect(listenerCount()).toBe(0)
  })
})

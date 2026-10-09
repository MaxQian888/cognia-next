/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
import type { ConversationRowItem } from "@/lib/inbox/conversation-grouping"
import {
  findRowButton,
  focusRowButton,
  useInboxTriageKeyboard,
  type UseInboxTriageKeyboardOptions,
} from "./use-inbox-triage-keyboard"

function row(id: string): ConversationRowItem {
  return {
    session: {
      id,
      title: id,
      platformBinding: { adapterId: "a1", conversationKey: `k-${id}`, platform: "telegram" },
    } as unknown as ChatSession,
    override: undefined,
    unreadCount: 0,
  }
}

const ROWS = [row("a"), row("b"), row("c"), row("d")]

type Handlers = Omit<
  UseInboxTriageKeyboardOptions,
  "enabled" | "rows" | "previewSessionId" | "checked" | "anchorId"
>

function handlers(): { [K in keyof Handlers]: jest.Mock } {
  return {
    onPreview: jest.fn(),
    onOpen: jest.fn(),
    onToggleCheck: jest.fn(),
    onSelectIds: jest.fn(),
    onSelectAll: jest.fn(),
    onClearChecked: jest.fn(),
    onClearPreview: jest.fn(),
    onFocusSearch: jest.fn(),
    onHelp: jest.fn(),
    onRowCommand: jest.fn(),
  }
}

function Harness(props: UseInboxTriageKeyboardOptions & { withInput?: boolean }) {
  const { onKeyDown } = useInboxTriageKeyboard(props)
  return (
    <div tabIndex={-1} onKeyDown={onKeyDown} data-testid="list">
      {props.rows.map((item) => (
        <div key={item.session.id}>
          <span data-inbox-row-check={item.session.id}>
            <button type="button" data-testid={`check-${item.session.id}`}>
              check
            </button>
          </span>
          <button
            type="button"
            data-inbox-row-select={item.session.id}
            data-testid={`row-${item.session.id}`}
          >
            {item.session.id}
          </button>
          <button type="button" data-testid={`menu-${item.session.id}`}>
            ⋯
          </button>
        </div>
      ))}
      {props.withInput ? <input data-testid="field" /> : null}
    </div>
  )
}

function setup(overrides: Partial<UseInboxTriageKeyboardOptions> = {}) {
  const h = handlers()
  const props: UseInboxTriageKeyboardOptions = {
    enabled: true,
    rows: ROWS,
    previewSessionId: null,
    checked: new Set(),
    anchorId: null,
    ...h,
    ...overrides,
  }
  const utils = render(<Harness {...props} withInput />)
  return { ...utils, h, props }
}

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn()
})

describe("useInboxTriageKeyboard", () => {
  it("moves down and up from the focused row, previewing and focusing the target", () => {
    const { h } = setup()
    const b = screen.getByTestId("row-b")
    b.focus()
    fireEvent.keyDown(b, { key: "j" })
    expect(h.onPreview).toHaveBeenCalledWith(ROWS[2])
    expect(document.activeElement).toBe(screen.getByTestId("row-c"))
    fireEvent.keyDown(screen.getByTestId("row-c"), { key: "ArrowUp" })
    expect(h.onPreview).toHaveBeenLastCalledWith(ROWS[1])
    expect(document.activeElement).toBe(b)
  })

  it("starts from the previewed row on the bare container, and jumps with Home / End", () => {
    const { h } = setup({ previewSessionId: "c" })
    const list = screen.getByTestId("list")
    fireEvent.keyDown(list, { key: "k" })
    expect(h.onPreview).toHaveBeenCalledWith(ROWS[1])
    fireEvent.keyDown(list, { key: "End" })
    expect(h.onPreview).toHaveBeenLastCalledWith(ROWS[3])
    fireEvent.keyDown(list, { key: "Home" })
    expect(h.onPreview).toHaveBeenLastCalledWith(ROWS[0])
  })

  it("extends the checked set from the anchor with Shift, keeping the anchor last", () => {
    const { h } = setup({ anchorId: "b" })
    fireEvent.keyDown(screen.getByTestId("row-b"), { key: "J", shiftKey: true })
    expect(h.onSelectIds).toHaveBeenCalledWith(["c", "b"])
    expect(h.onPreview).toHaveBeenCalledWith(ROWS[2])
  })

  it("anchors a fresh extension on the row being left", () => {
    const { h } = setup()
    fireEvent.keyDown(screen.getByTestId("row-c"), { key: "ArrowUp", shiftKey: true })
    expect(h.onSelectIds).toHaveBeenCalledWith(["b", "c"])
  })

  it("opens, checks, selects all, searches and shows help", () => {
    const { h } = setup()
    const b = screen.getByTestId("row-b")
    fireEvent.keyDown(b, { key: "o" })
    expect(h.onOpen).toHaveBeenCalledWith(ROWS[1])
    fireEvent.keyDown(b, { key: "x" })
    expect(h.onToggleCheck).toHaveBeenCalledWith("b")
    fireEvent.keyDown(b, { key: "a", metaKey: true })
    expect(h.onSelectAll).toHaveBeenCalled()
    fireEvent.keyDown(b, { key: "/" })
    expect(h.onFocusSearch).toHaveBeenCalled()
    fireEvent.keyDown(b, { key: "?", shiftKey: true })
    expect(h.onHelp).toHaveBeenCalled()
  })

  it("acts from a row's checkbox too", () => {
    const { h } = setup()
    fireEvent.keyDown(screen.getByTestId("check-d"), { key: "x" })
    expect(h.onToggleCheck).toHaveBeenCalledWith("d")
  })

  it("stops `/` from reaching app-level handlers", () => {
    setup()
    const windowListener = jest.fn()
    window.addEventListener("keydown", windowListener)
    fireEvent.keyDown(screen.getByTestId("row-a"), { key: "/" })
    window.removeEventListener("keydown", windowListener)
    expect(windowListener).not.toHaveBeenCalled()
  })

  it("runs triage keys on the focused row when nothing is checked", () => {
    const { h } = setup()
    fireEvent.keyDown(screen.getByTestId("row-a"), { key: "d" })
    expect(h.onRowCommand).toHaveBeenCalledWith("resolve", [ROWS[0]], "row")
    fireEvent.keyDown(screen.getByTestId("row-a"), { key: "s" })
    expect(h.onRowCommand).toHaveBeenLastCalledWith("snooze", [ROWS[0]], "row")
  })

  it("runs triage keys on the checked rows when any are checked", () => {
    const { h } = setup({ checked: new Set(["b", "d"]) })
    fireEvent.keyDown(screen.getByTestId("row-a"), { key: "u" })
    expect(h.onRowCommand).toHaveBeenCalledWith("toggleRead", [ROWS[1], ROWS[3]], "checked")
  })

  it("clears the checks first, then the preview, on Escape", () => {
    const first = setup({ checked: new Set(["a"]), previewSessionId: "b" })
    fireEvent.keyDown(screen.getByTestId("row-a"), { key: "Escape" })
    expect(first.h.onClearChecked).toHaveBeenCalled()
    expect(first.h.onClearPreview).not.toHaveBeenCalled()
    first.unmount()

    const second = setup({ previewSessionId: "b" })
    fireEvent.keyDown(screen.getByTestId("row-a"), { key: "Escape" })
    expect(second.h.onClearPreview).toHaveBeenCalled()
  })

  it("leaves other controls, text fields and menus alone", () => {
    const { h } = setup()
    fireEvent.keyDown(screen.getByTestId("menu-a"), { key: "j" })
    fireEvent.keyDown(screen.getByTestId("field"), { key: "j" })
    expect(h.onPreview).not.toHaveBeenCalled()
  })

  it("ignores a key a row already handled (Enter opens through the row itself)", () => {
    const { h } = setup()
    const a = screen.getByTestId("row-a")
    a.addEventListener("keydown", (event) => event.preventDefault())
    fireEvent.keyDown(a, { key: "Enter" })
    expect(h.onOpen).not.toHaveBeenCalled()
  })

  it("does nothing while disabled", () => {
    const { h } = setup({ enabled: false })
    fireEvent.keyDown(screen.getByTestId("row-a"), { key: "j" })
    expect(h.onPreview).not.toHaveBeenCalled()
  })
})

describe("row focus helpers", () => {
  it("finds and focuses a row button by session id without selector escaping", () => {
    render(
      <div data-testid="c">
        <button type="button" data-inbox-row-select={'we"ird id'}>
          weird
        </button>
      </div>
    )
    const container = screen.getByTestId("c")
    expect(findRowButton(container, 'we"ird id')).toBe(screen.getByText("weird"))
    expect(findRowButton(null, "x")).toBeNull()
    expect(focusRowButton(container, 'we"ird id')).toBe(true)
    expect(document.activeElement).toBe(screen.getByText("weird"))
    expect(focusRowButton(container, "missing")).toBe(false)
  })
})

/** @jest-environment jsdom */
import { createRef } from "react"
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react"
import { renderHook } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import {
  MessageSelectionToolbar,
  asideTitleFor,
  useTranscriptSelection,
} from "./message-selection-toolbar"

const mockCreate = jest.fn()
jest.mock("@/lib/db/resource-workbench-sessions", () => ({
  createResourceWorkbenchSession: (...a: unknown[]) => mockCreate(...(a as [])),
}))

const setSessionOverride = jest.fn()
jest.mock("@/stores/context-workbench/context-workbench-store", () => ({
  useContextWorkbenchStore: { getState: () => ({ setSessionOverride }) },
}))

const dispatchComposerAppend = jest.fn()
jest.mock("@/components/chat/composer", () => ({
  dispatchComposerAppend: (...a: unknown[]) => dispatchComposerAppend(...(a as [])),
}))

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

const messages = {
  chat: {
    selection: { askInAside: "Ask in an aside", askError: "Couldn't open an aside for that." },
  },
}

/**
 * Put a real DOM selection over `node`'s text.
 *
 * jsdom implements Selection/Range well enough for the component's checks
 * (containment, collapsed, toString). It has NO `Range.getClientRects` at all,
 * which the component guards for — throwing there would abort a
 * `selectionchange` listener over a button position.
 */
function selectText(node: Node) {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event("selectionchange"))
}

beforeEach(() => {
  jest.clearAllMocks()
  mockCreate.mockResolvedValue({ id: "aside-1", title: "quoted" })
  window.getSelection()?.removeAllRanges()
})

describe("asideTitleFor", () => {
  it("uses a short selection verbatim, collapsing whitespace", () => {
    expect(asideTitleFor("  check   the\nversions ")).toBe("check the versions")
  })

  it("elides a long selection on a word boundary", () => {
    const title = asideTitleFor("a".repeat(10) + " " + "b".repeat(60))
    expect(title.endsWith("…")).toBe(true)
    expect(title.length).toBeLessThanOrEqual(49)
  })

  it("hard-cuts a single unbroken run rather than returning nothing", () => {
    const title = asideTitleFor("x".repeat(200))
    expect(title).toBe("x".repeat(48) + "…")
  })
})

describe("useTranscriptSelection", () => {
  function setup() {
    const host = document.createElement("div")
    host.textContent = "a paragraph worth asking about"
    document.body.appendChild(host)
    const ref = createRef<HTMLElement>()
    ;(ref as { current: HTMLElement | null }).current = host
    return { host, ref }
  }

  it("reports a selection inside the container", () => {
    const { host, ref } = setup()
    const { result } = renderHook(() => useTranscriptSelection(ref))
    act(() => selectText(host))
    expect(result.current?.text).toBe("a paragraph worth asking about")
  })

  it("ignores a selection outside the container", () => {
    const { ref } = setup()
    const outside = document.createElement("div")
    outside.textContent = "the composer, not a message"
    document.body.appendChild(outside)

    const { result } = renderHook(() => useTranscriptSelection(ref))
    act(() => selectText(outside))
    expect(result.current).toBeNull()
  })

  it("ignores a selection too short to be deliberate", () => {
    const { host, ref } = setup()
    host.textContent = "ok"
    const { result } = renderHook(() => useTranscriptSelection(ref))
    act(() => selectText(host))
    expect(result.current).toBeNull()
  })
})

describe("MessageSelectionToolbar", () => {
  function renderToolbar() {
    const host = document.createElement("div")
    host.textContent = "the paragraph in question"
    document.body.appendChild(host)
    const ref = createRef<HTMLElement>()
    ;(ref as { current: HTMLElement | null }).current = host

    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MessageSelectionToolbar sessionId="main-1" containerRef={ref} />
      </NextIntlClientProvider>
    )
    return host
  }

  it("stays hidden until something is selected", () => {
    renderToolbar()
    expect(screen.queryByTestId("message-selection-toolbar")).not.toBeInTheDocument()
  })

  it("opens an aside named after the selection and seeds it with the quote", async () => {
    const host = renderToolbar()
    act(() => selectText(host))

    const button = await screen.findByRole("button", { name: "Ask in an aside" })
    // `mouseDown`, not `click`: a click would collapse the selection before the
    // handler runs and the quote would come back empty.
    await act(async () => {
      fireEvent.mouseDown(button)
    })

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        { kind: "session", sessionId: "main-1" },
        "the paragraph in question"
      )
    )
    // The dock is pointed at the new aside, and the quote lands in ITS composer
    // — not auto-sent, since the selection is the subject and not the question.
    expect(setSessionOverride).toHaveBeenCalledWith(expect.any(String), "aside-1")
    expect(dispatchComposerAppend).toHaveBeenCalledWith({
      text: "> the paragraph in question\n\n",
      sessionId: "aside-1",
    })
  })
})

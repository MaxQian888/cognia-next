/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"
import { expandFoldedLinks, LINK_MARKER } from "@/lib/chat/link-fold"
import { useLinkFolding } from "./use-link-folding"

/** A folded label as it appears in the text: one icon cell, then the label. */
const tok = (label: string) => `${LINK_MARKER}${label}`

function harness(initial = "") {
  const state = { value: initial, caret: 0 }
  const textarea = document.createElement("textarea")
  document.body.append(textarea)
  const setInput = jest.fn((next: string) => {
    state.value = next
    textarea.value = next
  })
  const setCaret = jest.fn((caret: number) => {
    state.caret = caret
  })
  textarea.value = initial
  const view = renderHook(
    ({ value }: { value: string }) =>
      useLinkFolding({ value, setInput, setCaret, textareaRef: { current: textarea } }),
    { initialProps: { value: initial } }
  )
  return { view, state, textarea, setInput, setCaret }
}

/** A minimal ClipboardEvent stand-in — jsdom does not implement the real one. */
function clipboardEvent(textarea: HTMLTextAreaElement) {
  const data = new Map<string, string>()
  return {
    currentTarget: textarea,
    clipboardData: { setData: (type: string, value: string) => data.set(type, value) },
    preventDefault: jest.fn(),
    written: data,
  } as unknown as React.ClipboardEvent<HTMLTextAreaElement> & {
    preventDefault: jest.Mock
    written: Map<string, string>
  }
}

describe("useLinkFolding", () => {
  it("folds a URL the caret has moved past and remembers the original", () => {
    const { view, setInput, state } = harness()
    act(() => view.result.current.fold("https://github.com/svenstaro/genact x", 37))
    expect(setInput).toHaveBeenCalledWith(`${tok("svenstaro/genact")} x`)
    expect(state.value).toBe(`${tok("svenstaro/genact")} x`)
    expect(view.result.current.links).toEqual({
      [tok("svenstaro/genact")]: "https://github.com/svenstaro/genact",
    })
  })

  it("leaves the URL alone while it is still being typed", () => {
    const { view, setInput } = harness()
    const typing = "https://github.com/svens"
    act(() => view.result.current.fold(typing, typing.length))
    expect(setInput).not.toHaveBeenCalled()
  })

  it("reports the folded token so the parser and overlay can see it", () => {
    const { view } = harness()
    act(() => view.result.current.fold("https://github.com/a/b ", -1))
    view.rerender({ value: `${tok("a/b")} ` })
    expect(view.result.current.isFoldedToken(tok("a/b"))).toBe(true)
    expect(view.result.current.isFoldedToken("a/b")).toBe(false)
    expect(view.result.current.spans[0]).toMatchObject({ raw: tok("a/b"), start: 0, end: 5 })
  })

  // The hook exposes no `expand`: the send path needs the SNAPSHOT map it took
  // before the optimistic clear, not this hook's live state, so it calls
  // `expandFoldedLinks` directly. That pure function is covered in
  // `lib/chat/link-fold.test.ts`; what belongs here is that `fold` records a
  // map which expands back to the original URL.
  it("records a map that expands back to the full URL", () => {
    const { view } = harness()
    act(() => view.result.current.fold("https://github.com/a/b", -1))
    expect(expandFoldedLinks(`see ${tok("a/b")}`, view.result.current.links)).toBe(
      "see https://github.com/a/b"
    )
  })

  it("puts the full URL on the clipboard when a folded label is copied", () => {
    const { view, textarea } = harness()
    act(() => view.result.current.fold("https://github.com/a/b", -1))
    textarea.value = tok("a/b")
    textarea.setSelectionRange(0, 5)
    const event = clipboardEvent(textarea)
    act(() => view.result.current.onCopy(event))
    expect(event.written.get("text/plain")).toBe("https://github.com/a/b")
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it("leaves an ordinary copy to the browser", () => {
    const { view, textarea } = harness("plain words")
    textarea.setSelectionRange(0, 5)
    const event = clipboardEvent(textarea)
    act(() => view.result.current.onCopy(event))
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it("cuts the expanded text and removes the selection itself", () => {
    const { view, textarea, setInput, setCaret } = harness()
    act(() => view.result.current.fold("https://github.com/a/b", -1))
    textarea.value = `x ${tok("a/b")} y`
    textarea.setSelectionRange(2, 7)
    const event = clipboardEvent(textarea)
    act(() => view.result.current.onCut(event))
    expect(event.written.get("text/plain")).toBe("https://github.com/a/b")
    // preventDefault cancels the browser's own removal, so the hook does it.
    expect(setInput).toHaveBeenLastCalledWith("x  y")
    expect(setCaret).toHaveBeenLastCalledWith(2)
  })
})

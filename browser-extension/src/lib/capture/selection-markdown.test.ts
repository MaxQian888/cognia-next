/** @jest-environment jsdom */
import { selectionToMarkdown, selectionToText } from "./selection-markdown"

const base = "https://example.com/page"
function select(node: Node): Selection {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  return selection
}

describe("selectionToMarkdown", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges()
    document.head.innerHTML = ""
  })

  it("keeps rich markup across a range and leaves the DOM intact", () => {
    document.body.innerHTML = '<p>Read <strong>this</strong> <a href="/more">link</a></p>'
    const before = document.body.innerHTML
    expect(selectionToMarkdown(select(document.body), base)).toBe(
      "Read **this** [link](https://example.com/more)"
    )
    expect(document.body.innerHTML).toBe(before)
  })

  it("escapes a substring selected inside a single text node", () => {
    document.body.innerHTML = "<p>before *text* after</p>"
    const selection = select(document.querySelector("p")!.firstChild!)
    const range = selection.getRangeAt(0)
    range.setStart(range.startContainer, 7)
    range.setEnd(range.endContainer, 13)
    expect(selectionToMarkdown(selection, base)).toBe("\\*text\\*")
    expect(selectionToText(selection)).toBe("*text*")
  })

  it("joins multiple ranges with a blank line", () => {
    document.body.innerHTML = "<p>first</p><p>second</p>"
    const ranges = Array.from(document.querySelectorAll("p")).map((p) => {
      const range = document.createRange()
      range.selectNodeContents(p)
      return range
    })
    const selection = { rangeCount: 2, getRangeAt: (index: number) => ranges[index] } as Selection
    expect(selectionToMarkdown(selection, base)).toBe("first\n\nsecond")
  })

  it("filters live inherited visibility and input from both representations", () => {
    document.head.innerHTML = "<style>body .secret { display:none }</style>"
    document.body.innerHTML =
      '<p>visible <span class="secret"><b>secret</b></span><textarea>draft</textarea> ending</p>'
    const selection = select(document.querySelector("p")!)
    expect(selectionToMarkdown(selection, base)).toBe("visible ending")
    expect(selectionToText(selection)).toBe("visible ending")
    expect(
      selectionToMarkdown(select(document.querySelector(".secret b")!.firstChild!), base)
    ).toBe("")
    document.body.innerHTML = '<div contenteditable="true"><b>private draft</b></div>'
    expect(selectionToMarkdown(select(document.querySelector("b")!.firstChild!), base)).toBe("")
  })

  it("handles partial boundary elements and collapsed selections", () => {
    document.body.innerHTML = "<p><b>before</b><i>after</i></p>"
    const range = document.createRange()
    range.setStart(document.querySelector("b")!.firstChild!, 2)
    range.setEnd(document.querySelector("i")!.firstChild!, 3)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(selectionToMarkdown(selection, base)).toBe("**fore***aft*")
    selection.collapseToStart()
    expect(selectionToMarkdown(selection, base)).toBe("")
  })
})

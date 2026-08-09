import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { DocumentViewer } from "./DocumentViewer"

const longBody = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")

/** Fire a key and flush the resulting local-state re-render. */
function fire(input: string, key: Record<string, boolean> = {}): void {
  act(() => __fireInput(input, key))
}

describe("DocumentViewer", () => {
  beforeEach(() => __resetInk())

  it("renders the title and a viewport window of text lines", () => {
    const { container } = render(
      <DocumentViewer
        title="Doc"
        body={longBody}
        format="text"
        onClose={() => {}}
        viewportRows={16}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Doc")
    expect(text).toContain("line 1")
    expect(text).toContain("line 10")
    // Beyond the viewport window is not rendered yet.
    expect(text).not.toContain("line 11")
    expect(text).toContain("1–10 / 100")
  })

  it("scrolls down a line on ↓ and up on ↑", () => {
    const { container } = render(
      <DocumentViewer
        title="Doc"
        body={longBody}
        format="text"
        onClose={() => {}}
        viewportRows={16}
      />
    )
    fire("", { downArrow: true })
    expect(container.textContent).toContain("line 11")
    fire("", { upArrow: true })
    expect(container.textContent).toContain("1–10 / 100")
  })

  it("scrolls on the mouse wheel (down then up) and ignores the raw escape", () => {
    const { container } = render(
      <DocumentViewer
        title="Doc"
        body={longBody}
        format="text"
        onClose={() => {}}
        viewportRows={16}
      />
    )
    // SGR wheel-down → scroll forward by WHEEL_SCROLL_LINES (3).
    fire("[<65;5;5M")
    expect(container.textContent).toContain("4–13 / 100")
    // The raw escape must not have been rendered as document text.
    expect(container.textContent ?? "").not.toContain("[<65")
    // SGR wheel-up → scroll back.
    fire("[<64;5;5M")
    expect(container.textContent).toContain("1–10 / 100")
  })

  it("pages with PgDn and jumps to the bottom on G", () => {
    const { container } = render(
      <DocumentViewer
        title="Doc"
        body={longBody}
        format="text"
        onClose={() => {}}
        viewportRows={16}
      />
    )
    fire("", { pageDown: true })
    expect(container.textContent).toContain("line 11")
    fire("G")
    expect(container.textContent).toContain("line 100")
    expect(container.textContent).toContain("91–100 / 100")
  })

  it("clamps scrolling at the top and bottom", () => {
    const { container } = render(
      <DocumentViewer
        title="Doc"
        body={longBody}
        format="text"
        onClose={() => {}}
        viewportRows={16}
      />
    )
    fire("", { upArrow: true }) // already at top
    expect(container.textContent).toContain("1–10 / 100")
    fire("G")
    fire("", { downArrow: true }) // already at bottom
    expect(container.textContent).toContain("91–100 / 100")
  })

  it("pages with Space/b and returns to the top on g", () => {
    const { container } = render(
      <DocumentViewer
        title="Doc"
        body={longBody}
        format="text"
        onClose={() => {}}
        viewportRows={16}
      />
    )
    fire(" ") // space → page down
    expect(container.textContent).toContain("line 11")
    fire("b") // b → page up
    expect(container.textContent).toContain("1–10 / 100")
    fire("G")
    fire("g") // g → back to top
    expect(container.textContent).toContain("1–10 / 100")
  })

  it("falls back to the terminal height when no viewportRows is given", () => {
    const { container } = render(
      <DocumentViewer title="Doc" body={"a\nb\nc"} format="text" onClose={() => {}} />
    )
    expect(container.textContent).toContain("Doc")
    expect(container.textContent).toContain("a")
  })

  it("renders markdown bodies through the markdown renderer", () => {
    const { container } = render(
      <DocumentViewer
        title="Skill"
        body={"# Heading\n\nsome **bold** text"}
        format="markdown"
        onClose={() => {}}
        viewportRows={20}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Heading")
    expect(text).toContain("bold")
  })

  it("closes on Escape, q, and Enter", () => {
    const onClose = jest.fn()
    render(
      <DocumentViewer
        title="Doc"
        body={longBody}
        format="text"
        onClose={onClose}
        viewportRows={16}
      />
    )
    fire("", { escape: true })
    fire("q")
    fire("", { return: true })
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it("shows 'all' for a document that fits the viewport", () => {
    const { container } = render(
      <DocumentViewer
        title="Doc"
        body={"a\nb\nc"}
        format="text"
        onClose={() => {}}
        viewportRows={16}
      />
    )
    expect(container.textContent).toContain("all")
  })

  it("searches, jumps between matches, and copies the complete document", () => {
    const onCopy = jest.fn()
    const { container } = render(
      <DocumentViewer
        title="Transcript"
        body={longBody}
        format="text"
        onClose={() => {}}
        onCopy={onCopy}
        viewportRows={16}
      />
    )
    fire("/")
    for (const char of "line 50") fire(char)
    fire("", { return: true })
    expect(container.textContent).toContain("line 50")
    expect(container.textContent).toContain("1/1 matches")
    fire("y")
    expect(onCopy).toHaveBeenCalledWith(longBody)
  })
})

/**
 * @jest-environment jsdom
 *
 * Tests for CanvasOutlinePanel — confirms it parses symbols for supported
 * languages, shows an empty state otherwise, and dispatches canvas-goto-line
 * when a symbol is clicked.
 */

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  CANVAS_GOTO_LINE_EVENT,
  CanvasOutlinePanel,
  countCanvasSymbols,
  parseCanvasSymbols,
} from "./canvas-outline-panel"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import type { ArtifactLanguage } from "@/types/artifact/artifact"

const TS_SOURCE = `function greet(name) {
  return "hi " + name
}

class Widget {
  render() {
    return null
  }
}
`

function seedDoc(content: string, language: ArtifactLanguage) {
  let id = ""
  act(() => {
    id = useArtifactStore.getState().createCanvasDocument({
      sessionId: "s1",
      title: "Doc",
      content,
      language,
      type: language === "markdown" ? "text" : "code",
    })
  })
  return id
}

function resetStore() {
  act(() => {
    Object.keys(useArtifactStore.getState().canvasDocuments).forEach((id) =>
      useArtifactStore.getState().deleteCanvasDocument(id)
    )
  })
}

describe("parseCanvasSymbols / countCanvasSymbols", () => {
  it("parses supported languages and returns [] for unsupported ones", () => {
    const symbols = parseCanvasSymbols({ content: TS_SOURCE, language: "typescript" })
    expect(symbols.length).toBeGreaterThan(0)
    expect(symbols.map((s) => s.name)).toEqual(expect.arrayContaining(["greet", "Widget"]))
    expect(parseCanvasSymbols({ content: "# heading", language: "markdown" })).toEqual([])
    expect(parseCanvasSymbols(undefined)).toEqual([])
  })

  it("counts nested symbols", () => {
    expect(countCanvasSymbols([])).toBe(0)
    expect(
      countCanvasSymbols([
        {
          name: "a",
          kind: "class",
          range: {} as never,
          selectionRange: {} as never,
          children: [
            { name: "b", kind: "method", range: {} as never, selectionRange: {} as never },
          ],
        },
      ])
    ).toBe(2)
  })
})

describe("CanvasOutlinePanel", () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetStore()
  })

  it("renders a tree of symbols for a TypeScript document", () => {
    const id = seedDoc(TS_SOURCE, "typescript")
    render(<CanvasOutlinePanel documentId={id} />)
    expect(screen.getByRole("tree")).toBeInTheDocument()
    const names = screen.getAllByRole("treeitem").map((el) => el.getAttribute("aria-label"))
    expect(names).toEqual(expect.arrayContaining(["greet", "Widget"]))
  })

  it("renders variable symbols with the variable icon", () => {
    const id = seedDoc("const answer = 42\nlet total = 1\n", "typescript")
    render(<CanvasOutlinePanel documentId={id} />)
    const names = screen.getAllByRole("treeitem").map((el) => el.getAttribute("aria-label"))
    expect(names).toEqual(expect.arrayContaining(["answer"]))
  })

  it("shows the empty state for an unsupported language", () => {
    const id = seedDoc("# Notes", "markdown")
    render(<CanvasOutlinePanel documentId={id} />)
    expect(screen.getByText(/No symbols detected/i)).toBeInTheDocument()
    expect(screen.queryByRole("tree")).not.toBeInTheDocument()
  })

  it("dispatches canvas-goto-line with the symbol's start line when clicked", async () => {
    const user = userEvent.setup()
    const id = seedDoc(TS_SOURCE, "typescript")
    const handler = jest.fn()
    window.addEventListener(CANVAS_GOTO_LINE_EVENT, handler as EventListener)
    render(<CanvasOutlinePanel documentId={id} />)
    await user.click(screen.getAllByRole("treeitem", { name: "greet" })[0])
    window.removeEventListener(CANVAS_GOTO_LINE_EVENT, handler as EventListener)
    expect(handler).toHaveBeenCalledTimes(1)
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail
    expect(detail.line).toBe(1)
  })
})

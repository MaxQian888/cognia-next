import { render, screen, fireEvent } from "@testing-library/react"
import { MonacoDiagnosticsBar } from "./monaco-diagnostics-bar"
import type { MonacoLike, EditorLike, RawMarker } from "@/hooks/use-monaco-markers"

function makeMonaco(markers: RawMarker[]): MonacoLike {
  return {
    editor: {
      getModelMarkers: () => markers,
      onDidChangeMarkers: () => ({ dispose: () => {} }),
    },
  }
}

function makeEditor() {
  const calls: Record<string, number> = {}
  const editor: EditorLike & { calls: Record<string, number>; jumped?: number } = {
    calls,
    getModel: () => ({ uri: { toString: () => "skill:///s/a.ts" } }),
    setPosition(p) {
      editor.jumped = p.lineNumber
    },
    revealLineInCenterIfOutsideViewport() {},
    focus() {},
    getAction(id) {
      return { run: () => (calls[id] = (calls[id] ?? 0) + 1) }
    },
  }
  return editor
}

const mk = (severity: number, line: number, col = 1, message = "boom"): RawMarker => ({
  severity,
  message,
  startLineNumber: line,
  startColumn: col,
  endLineNumber: line,
  endColumn: col + 1,
})

describe("MonacoDiagnosticsBar", () => {
  it("renders nothing until monaco and editor are present", () => {
    const { container } = render(<MonacoDiagnosticsBar monaco={null} editor={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows 'no problems' with disabled navigation when clean", () => {
    render(<MonacoDiagnosticsBar monaco={makeMonaco([])} editor={makeEditor()} />)
    expect(screen.getByTestId("monaco-diagnostics-bar")).toBeInTheDocument()
    expect(screen.getByText("No problems")).toBeInTheDocument()
    expect(screen.getByLabelText("Next problem")).toBeDisabled()
    expect(screen.getByLabelText("Toggle problems panel")).toBeDisabled()
  })

  it("renders error/warning counts", () => {
    render(
      <MonacoDiagnosticsBar
        monaco={makeMonaco([mk(8, 1), mk(8, 2), mk(4, 3)])}
        editor={makeEditor()}
      />
    )
    expect(screen.getByLabelText("Errors")).toHaveTextContent("2")
    expect(screen.getByLabelText("Warnings")).toHaveTextContent("1")
  })

  it("runs Monaco marker navigation on prev/next", () => {
    const editor = makeEditor()
    render(<MonacoDiagnosticsBar monaco={makeMonaco([mk(8, 1)])} editor={editor} />)
    fireEvent.click(screen.getByLabelText("Next problem"))
    fireEvent.click(screen.getByLabelText("Previous problem"))
    expect(editor.calls["editor.action.marker.next"]).toBe(1)
    expect(editor.calls["editor.action.marker.prev"]).toBe(1)
  })

  it("toggles the problems list and jumps to a marker on click", () => {
    const editor = makeEditor()
    render(
      <MonacoDiagnosticsBar monaco={makeMonaco([mk(8, 12, 5, "bad token")])} editor={editor} />
    )
    const toggle = screen.getByLabelText("Toggle problems panel")
    expect(screen.queryByTestId("monaco-problems-list")).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-pressed", "true")
    const list = screen.getByTestId("monaco-problems-list")
    expect(list).toHaveTextContent("12:5")
    expect(list).toHaveTextContent("bad token")
    fireEvent.click(screen.getByText("bad token"))
    expect(editor.jumped).toBe(12)
    // Collapsing again removes the list.
    fireEvent.click(toggle)
    expect(screen.queryByTestId("monaco-problems-list")).not.toBeInTheDocument()
  })
})

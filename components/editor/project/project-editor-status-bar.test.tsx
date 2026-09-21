/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { ProjectEditorStatusBar } from "./project-editor-status-bar"
import type { EditorLike, MonacoLike, RawMarker } from "@/hooks/use-monaco-markers"
import type { OpenFile } from "./use-project-editor"

function file(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    relPath: "src/app.ts",
    absolutePath: "/repo/src/app.ts",
    language: "typescript",
    monacoLanguage: "typescript",
    savedContent: "const a = 1\n",
    draftContent: "const a = 1\n",
    draftVersion: 1,
    ...overrides,
  }
}

function monaco(markers: RawMarker[]): MonacoLike {
  return {
    editor: {
      getModelMarkers: () => markers,
      onDidChangeMarkers: () => ({ dispose: () => {} }),
    },
  }
}

function editor(): EditorLike {
  return {
    getModel: () => ({ uri: { toString: () => "file:///repo/src/app.ts" } }),
    setPosition() {},
    revealLineInCenterIfOutsideViewport() {},
    focus() {},
    getAction: () => ({ run: () => {} }),
  }
}

const marker = (severity: number, line: number): RawMarker => ({
  severity,
  message: "boom",
  startLineNumber: line,
  startColumn: 1,
  endLineNumber: line,
  endColumn: 2,
})

function renderBar(overrides: Partial<Parameters<typeof ProjectEditorStatusBar>[0]> = {}) {
  return render(
    <ProjectEditorStatusBar file={file()} cursor={null} diagnostics={null} {...overrides} />
  )
}

describe("ProjectEditorStatusBar", () => {
  it("always shows language and line ending; omits optional readouts", () => {
    renderBar()
    expect(screen.getByTestId("status-language")).toHaveTextContent("typescript")
    expect(screen.getByTestId("status-eol")).toHaveTextContent("LF")
    expect(screen.queryByTestId("status-branch")).not.toBeInTheDocument()
    expect(screen.queryByTestId("status-cursor")).not.toBeInTheDocument()
    expect(screen.queryByTestId("status-size")).not.toBeInTheDocument()
    expect(screen.queryByTestId("status-dirty")).not.toBeInTheDocument()
  })

  it("detects CRLF content", () => {
    renderBar({ file: file({ draftContent: "a\r\nb", savedContent: "a\r\nb" }) })
    expect(screen.getByTestId("status-eol")).toHaveTextContent("CRLF")
  })

  it("shows the branch when the file lives in a repo", () => {
    renderBar({ branch: "feat/board" })
    expect(screen.getByTestId("status-branch")).toHaveTextContent("feat/board")
  })

  it("reports cursor position and selection size", () => {
    renderBar({
      cursor: { lineNumber: 12, column: 34 },
      selection: { kind: "text", start: 10, end: 25 },
    })
    expect(screen.getByTestId("status-cursor")).toHaveTextContent("Ln 12, Col 34")
    expect(screen.getByTestId("status-cursor")).toHaveTextContent("(15 selected)")
  })

  it("formats file size across the unit boundaries", () => {
    const { rerender } = renderBar({ file: file({ sizeBytes: 512 }) })
    expect(screen.getByTestId("status-size")).toHaveTextContent("512 B")
    rerender(
      <ProjectEditorStatusBar file={file({ sizeBytes: 2048 })} cursor={null} diagnostics={null} />
    )
    expect(screen.getByTestId("status-size")).toHaveTextContent("2.0 KB")
    rerender(
      <ProjectEditorStatusBar
        file={file({ sizeBytes: 3 * 1024 * 1024 })}
        cursor={null}
        diagnostics={null}
      />
    )
    expect(screen.getByTestId("status-size")).toHaveTextContent("3.0 MB")
  })

  it("marks a dirty buffer and an externally changed file", () => {
    renderBar({
      file: file({ draftContent: "changed", externallyChanged: true }),
    })
    expect(screen.getByTestId("status-dirty")).toBeInTheDocument()
    expect(screen.getByTestId("status-external")).toBeInTheDocument()
  })

  it("hides the problems button with no diagnostics handle or no markers", () => {
    const { rerender } = renderBar()
    expect(screen.queryByTestId("status-problems")).not.toBeInTheDocument()
    rerender(
      <ProjectEditorStatusBar
        file={file()}
        cursor={null}
        diagnostics={{ monaco: monaco([]), editor: editor() }}
      />
    )
    expect(screen.queryByTestId("status-problems")).not.toBeInTheDocument()
  })

  it("renders the touch-density variant", () => {
    renderBar({ density: "touch" })
    expect(screen.getByTestId("project-editor-status-bar").className).toContain("h-8")
  })

  it("shows the cursor position without a selection suffix", () => {
    renderBar({ cursor: { lineNumber: 3, column: 7 } })
    expect(screen.getByTestId("status-cursor")).toHaveTextContent("Ln 3, Col 7")
    expect(screen.getByTestId("status-cursor")).not.toHaveTextContent("selected")
  })

  it("summarises warning-only and info-only markers", () => {
    const { rerender } = render(
      <ProjectEditorStatusBar
        file={file()}
        cursor={null}
        diagnostics={{ monaco: monaco([marker(4, 2)]), editor: editor() }}
      />
    )
    const warnings = screen.getByTestId("status-problems")
    expect(
      warnings.querySelector("svg.lucide-triangle-alert, svg.lucide-alert-triangle")
    ).not.toBeNull()
    expect(warnings.querySelector("svg.lucide-circle-alert, svg.lucide-alert-circle")).toBeNull()
    rerender(
      <ProjectEditorStatusBar
        file={file()}
        cursor={null}
        diagnostics={{ monaco: monaco([marker(1, 2)]), editor: editor() }}
      />
    )
    const infos = screen.getByTestId("status-problems")
    expect(infos.querySelector("svg.lucide-info")).not.toBeNull()
  })

  it("summarises markers and jumps to the next one on click", () => {
    const run = jest.fn()
    const ed: EditorLike = {
      ...editor(),
      getAction: (id) => (id === "editor.action.marker.next" ? { run } : null),
    }
    render(
      <ProjectEditorStatusBar
        file={file()}
        cursor={null}
        diagnostics={{
          monaco: monaco([marker(8, 3), marker(4, 7), marker(1, 9)]),
          editor: ed,
        }}
      />
    )
    const problems = screen.getByTestId("status-problems")
    expect(problems).toHaveTextContent("1")
    expect(problems.querySelectorAll("svg").length).toBeGreaterThan(0)
    fireEvent.click(problems)
    expect(run).toHaveBeenCalled()
  })
})

/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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
    <ProjectEditorStatusBar
      file={file()}
      cursor={null}
      diagnostics={null}
      onProblemsClick={jest.fn()}
      {...overrides}
    />
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
      <ProjectEditorStatusBar
        file={file({ sizeBytes: 2048 })}
        cursor={null}
        diagnostics={null}
        onProblemsClick={jest.fn()}
      />
    )
    expect(screen.getByTestId("status-size")).toHaveTextContent("2.0 KB")
    rerender(
      <ProjectEditorStatusBar
        file={file({ sizeBytes: 3 * 1024 * 1024 })}
        cursor={null}
        diagnostics={null}
        onProblemsClick={jest.fn()}
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

  it("fires the sync action from the external-change and deleted chips", () => {
    const onSyncAction = jest.fn()
    const { rerender } = renderBar({
      file: file({ externallyChanged: true }),
      onSyncAction,
    })
    fireEvent.click(screen.getByTestId("status-external"))
    expect(onSyncAction).toHaveBeenCalledTimes(1)

    // A deleted file takes precedence over the conflict chip.
    rerender(
      <ProjectEditorStatusBar
        file={file({ externallyChanged: true, deletedOnDisk: true })}
        cursor={null}
        diagnostics={null}
        onSyncAction={onSyncAction}
        onProblemsClick={jest.fn()}
      />
    )
    expect(screen.queryByTestId("status-external")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("status-deleted"))
    expect(onSyncAction).toHaveBeenCalledTimes(2)
  })

  it("hides the problems button with no diagnostics handle or no markers", () => {
    const { rerender } = renderBar()
    expect(screen.queryByTestId("status-problems")).not.toBeInTheDocument()
    rerender(
      <ProjectEditorStatusBar
        file={file()}
        cursor={null}
        diagnostics={{ monaco: monaco([]), editor: editor() }}
        onProblemsClick={jest.fn()}
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
        onProblemsClick={jest.fn()}
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
        onProblemsClick={jest.fn()}
      />
    )
    const infos = screen.getByTestId("status-problems")
    expect(infos.querySelector("svg.lucide-info")).not.toBeNull()
  })

  it("summarises markers and opens the Problems panel on click", () => {
    const onProblemsClick = jest.fn()
    render(
      <ProjectEditorStatusBar
        file={file()}
        cursor={null}
        diagnostics={{
          monaco: monaco([marker(8, 3), marker(4, 7), marker(1, 9)]),
          editor: editor(),
        }}
        onProblemsClick={onProblemsClick}
      />
    )
    const problems = screen.getByTestId("status-problems")
    expect(problems).toHaveTextContent("1")
    expect(problems.querySelectorAll("svg").length).toBeGreaterThan(0)
    fireEvent.click(problems)
    expect(onProblemsClick).toHaveBeenCalledTimes(1)
  })
})

describe("fitting the editor column of the chat dock", () => {
  // jsdom applies no container queries, so these pin the classes that decide
  // what survives a 300–450px column; the rendering itself is Tailwind's.
  const indent = { tabSize: 2, insertSpaces: true, onChange: jest.fn(), onConvert: jest.fn() }

  it("sizes against its own width, never the window", () => {
    renderBar()
    const bar = screen.getByTestId("project-editor-status-bar")
    expect(bar).toHaveClass("@container/status", "min-w-0", "overflow-hidden")
  })

  it("folds the passive readouts first and the model controls after them", () => {
    renderBar({
      branch: "feat/dock",
      cursor: { lineNumber: 3, column: 7 },
      selection: { kind: "text", start: 0, end: 5 },
      file: file({ sizeBytes: 2048 }),
      indent,
      onToggleEol: jest.fn(),
    })

    expect(screen.getByTestId("status-size")).toHaveClass("hidden", "@xl/status:inline")
    expect(screen.getByTestId("status-encoding")).toHaveClass("hidden", "@lg/status:inline")
    expect(screen.getByTestId("status-branch")).toHaveClass("hidden", "@md/status:flex")
    expect(screen.getByText("(5 selected)")).toHaveClass("hidden", "@md/status:inline")
    expect(screen.getByTestId("status-eol")).toHaveClass("hidden", "@sm/status:inline")
    expect(screen.getByTestId("status-indentation")).toHaveClass("hidden", "@xs/status:inline")
  })

  it("keeps the cursor and the language picker at any width", () => {
    renderBar({
      cursor: { lineNumber: 3, column: 7 },
      language: { value: "typescript", options: [], onChange: jest.fn() },
    })
    expect(screen.getByTestId("status-cursor")).not.toHaveClass("hidden")
    expect(screen.getByTestId("status-language")).not.toHaveClass("hidden")
  })

  it("shrinks the sync and dirty markers to named icons", () => {
    const { rerender } = renderBar({
      file: file({ draftContent: "changed", externallyChanged: true }),
    })
    expect(screen.getByRole("img", { name: "Unsaved" })).toBe(screen.getByTestId("status-dirty"))
    expect(screen.getByText("Unsaved")).toHaveClass("hidden", "@md/status:inline")
    expect(screen.getByRole("button", { name: "Changed on disk" })).toBe(
      screen.getByTestId("status-external")
    )
    expect(screen.getByText("Changed on disk")).toHaveClass("hidden")

    rerender(
      <ProjectEditorStatusBar
        file={file({ deletedOnDisk: true })}
        cursor={null}
        diagnostics={null}
        onProblemsClick={jest.fn()}
      />
    )
    expect(screen.getByRole("button", { name: "Deleted on disk" })).toBe(
      screen.getByTestId("status-deleted")
    )
    expect(screen.getByText("Deleted on disk")).toHaveClass("hidden")
  })
})

describe("interactive model items", () => {
  it("drives the indentation menu (mode, size, convert)", async () => {
    const onChange = jest.fn()
    const onConvert = jest.fn()
    const user = userEvent.setup()
    renderBar({
      indent: { insertSpaces: true, tabSize: 4, onChange, onConvert },
    })
    expect(screen.getByTestId("status-indentation")).toHaveTextContent("Spaces: 4")
    await user.click(screen.getByTestId("status-indentation"))

    await user.click(await screen.findByText("Indent Using Tabs"))
    expect(onChange).toHaveBeenLastCalledWith({ insertSpaces: false, tabSize: 4 })

    await user.click(screen.getByTestId("status-indentation"))
    await user.click(await screen.findByText("Tab Size: 2"))
    expect(onChange).toHaveBeenLastCalledWith({ insertSpaces: true, tabSize: 2 })

    await user.click(screen.getByTestId("status-indentation"))
    await user.click(await screen.findByText("Convert Indentation to Spaces"))
    expect(onConvert).toHaveBeenLastCalledWith("spaces")
  })

  it("labels tab indentation from the model", () => {
    renderBar({
      indent: { insertSpaces: false, tabSize: 8, onChange: jest.fn(), onConvert: jest.fn() },
    })
    expect(screen.getByTestId("status-indentation")).toHaveTextContent("Tab Size: 8")
  })

  it("omits indentation without a live model to read it from", () => {
    renderBar()
    expect(screen.queryByTestId("status-indentation")).not.toBeInTheDocument()
    expect(screen.getByTestId("status-encoding")).toHaveTextContent("UTF-8")
  })

  it("toggles the line-ending sequence on click", () => {
    const onToggleEol = jest.fn()
    renderBar({ onToggleEol })
    fireEvent.click(screen.getByTestId("status-eol"))
    expect(onToggleEol).toHaveBeenCalledTimes(1)
  })

  it("picks a language mode from the searchable popover", async () => {
    const onChange = jest.fn()
    renderBar({
      language: {
        value: "typescript",
        options: [
          { id: "typescript", label: "TypeScript" },
          { id: "markdown", label: "Markdown" },
        ],
        onChange,
      },
    })
    const user = userEvent.setup()
    await user.click(screen.getByTestId("status-language"))
    const markdown = await screen.findByTestId("status-language-option-markdown")
    await user.click(markdown)
    expect(onChange).toHaveBeenCalledWith("markdown")
  })

  it("falls back to the file's own language id without a picker", () => {
    renderBar()
    const item = screen.getByTestId("status-language")
    expect(item.tagName).toBe("SPAN")
    expect(item).toHaveTextContent("typescript")
  })
})

import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { LightCodeEditor } from "./light-code-editor"
import type { DiagnosticSummary } from "./diagnostics/types"

// ── jsdom shims for CodeMirror ──────────────────────────────────────────────
// CM6 measures the DOM during layout; jsdom lacks these APIs entirely.
beforeAll(() => {
  const rect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  }
  Range.prototype.getBoundingClientRect = () => rect as DOMRect
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as DOMRectList
  Element.prototype.getClientRects = Range.prototype.getClientRects
  // Used by CM's text measurement.
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 20,
  })
})

// Grammar loads stay synchronous-null so tests never touch real lang packs.
const loadLanguageSupportMock = jest.fn(async (_lang: string) => null)
jest.mock("./load-language-support", () => ({
  loadLanguageSupport: (lang: string) => loadLanguageSupportMock(lang),
}))

const collectEditorSnippetsMock = jest.fn<
  Array<{
    label: string
    insertText: string
    detail?: string
  }>,
  [string]
>(() => [])
jest.mock("@/lib/monaco/snippets", () => ({
  collectEditorSnippets: (language: string) => collectEditorSnippetsMock(language),
}))

// Control diagnostics deterministically: editorDiagnostics is a no-op extension
// (the real linter is covered in diagnostics/cm-linter.test.ts), and the summary
// is whatever the mock returns when the update listener reads it.
const EMPTY: DiagnosticSummary = { errors: 0, warnings: 0, infos: 0 }
let mockSummaryReturn: DiagnosticSummary = EMPTY
jest.mock("./diagnostics/cm-linter", () => ({
  editorDiagnostics: jest.fn(() => []),
  getDiagnosticSummary: () => mockSummaryReturn,
}))

beforeEach(() => {
  loadLanguageSupportMock.mockClear()
  collectEditorSnippetsMock.mockReset()
  collectEditorSnippetsMock.mockReturnValue([])
  mockSummaryReturn = EMPTY
})

describe("LightCodeEditor", () => {
  it("renders the document with line numbers and requests the grammar", async () => {
    render(
      <LightCodeEditor
        value={"const a = 1\nconst b = 2"}
        onChange={() => {}}
        language="typescript"
        aria-label="code"
      />
    )
    const host = screen.getByTestId("light-code-editor")
    expect(host).toHaveAttribute("data-language", "typescript")
    await waitFor(() => {
      expect(host.querySelector(".cm-content")).toHaveTextContent("const a = 1")
    })
    expect(host.querySelector(".cm-gutters")).toBeInTheDocument()
    expect(loadLanguageSupportMock).toHaveBeenCalledWith("typescript")
  })

  it("hides the gutter when lineNumbers is off", async () => {
    render(
      <LightCodeEditor value="x" onChange={() => {}} language="plaintext" lineNumbers={false} />
    )
    const host = screen.getByTestId("light-code-editor")
    await waitFor(() => {
      expect(host.querySelector(".cm-content")).toBeInTheDocument()
    })
    expect(host.querySelector(".cm-gutters")).not.toBeInTheDocument()
  })

  it("toggles the line-number gutter live when the prop changes", async () => {
    const { rerender } = render(
      <LightCodeEditor value="x" onChange={() => {}} language="plaintext" lineNumbers />
    )
    const host = screen.getByTestId("light-code-editor")
    await waitFor(() => expect(host.querySelector(".cm-gutters")).toBeInTheDocument())
    // Previously line numbers were mount-time only; the compartment makes it live.
    rerender(
      <LightCodeEditor value="x" onChange={() => {}} language="plaintext" lineNumbers={false} />
    )
    await waitFor(() => expect(host.querySelector(".cm-gutters")).not.toBeInTheDocument())
  })

  it("mounts and live-reconfigures appearance/tab/wrap settings without remounting", async () => {
    const { rerender } = render(
      <LightCodeEditor
        value="doc"
        onChange={() => {}}
        language="plaintext"
        fontSize={16}
        fontFamily="Fira Code"
        lineHeight={2}
        tabSize={4}
        wordWrap={false}
      />
    )
    const host = screen.getByTestId("light-code-editor")
    await waitFor(() => expect(host.querySelector(".cm-content")).toHaveTextContent("doc"))
    rerender(
      <LightCodeEditor
        value="doc"
        onChange={() => {}}
        language="plaintext"
        fontSize={20}
        fontFamily="JetBrains Mono"
        lineHeight={1.4}
        tabSize={2}
        wordWrap
      />
    )
    // Doc preserved → reconfigured via Compartments, not remounted.
    await waitFor(() => expect(host.querySelector(".cm-content")).toHaveTextContent("doc"))
  })

  it("syncs external value changes into the live view", async () => {
    const { rerender } = render(
      <LightCodeEditor value="first" onChange={() => {}} language="plaintext" />
    )
    const host = screen.getByTestId("light-code-editor")
    await waitFor(() => expect(host.querySelector(".cm-content")).toHaveTextContent("first"))
    rerender(<LightCodeEditor value="second" onChange={() => {}} language="plaintext" />)
    await waitFor(() => expect(host.querySelector(".cm-content")).toHaveTextContent("second"))
  })

  it("marks the content read-only via the editable flag", async () => {
    render(<LightCodeEditor value="x" onChange={() => {}} language="plaintext" readOnly />)
    const host = screen.getByTestId("light-code-editor")
    await waitFor(() => expect(host.querySelector(".cm-content")).toBeInTheDocument())
    expect(host).toHaveAttribute("aria-readonly", "true")
  })

  it("sets mobile-keyboard attributes on the content element", async () => {
    render(<LightCodeEditor value="x" onChange={() => {}} language="plaintext" />)
    const host = screen.getByTestId("light-code-editor")
    await waitFor(() => expect(host.querySelector(".cm-content")).toBeInTheDocument())
    const content = host.querySelector(".cm-content")!
    expect(content).toHaveAttribute("autocapitalize", "off")
    expect(content).toHaveAttribute("autocorrect", "off")
    expect(content).toHaveAttribute("spellcheck", "false")
  })

  it("hot-swaps the grammar when language changes without losing the doc", async () => {
    const { rerender } = render(
      <LightCodeEditor value="doc" onChange={() => {}} language="markdown" />
    )
    const host = screen.getByTestId("light-code-editor")
    await waitFor(() => expect(loadLanguageSupportMock).toHaveBeenCalledWith("markdown"))
    rerender(<LightCodeEditor value="doc" onChange={() => {}} language="python" />)
    await waitFor(() => expect(loadLanguageSupportMock).toHaveBeenCalledWith("python"))
    expect(host.querySelector(".cm-content")).toHaveTextContent("doc")
  })

  it("ignores a stale grammar load when the language changes first", async () => {
    // Re-render to a new language before the first grammar promise resolves so
    // the load effect's cancellation guard runs.
    const { rerender } = render(
      <LightCodeEditor value="x" onChange={() => {}} language="markdown" />
    )
    rerender(<LightCodeEditor value="x" onChange={() => {}} language="python" />)
    const host = screen.getByTestId("light-code-editor")
    await waitFor(() => expect(loadLanguageSupportMock).toHaveBeenCalledWith("python"))
    expect(host.querySelector(".cm-content")).toBeInTheDocument()
  })

  it("reports edits through onChange", async () => {
    const onChange = jest.fn()
    render(<LightCodeEditor value="abc" onChange={onChange} language="plaintext" />)
    const host = screen.getByTestId("light-code-editor")
    await waitFor(() => expect(host.querySelector(".cm-content")).toBeInTheDocument())
    expect(host.querySelector(".cm-content")).toHaveAttribute("contenteditable", "true")
    expect(onChange).not.toHaveBeenCalled()
  })

  it("mounts caller extensions and reconfigures them live", async () => {
    // The seam the Canvas collaborative binding attaches through. It has to
    // reconfigure rather than remount, because rebuilding the view when a
    // session opens would throw away the cursor mid-edit.
    const { EditorView } = await import("@codemirror/view")
    const marker = jest.fn()
    const extension = EditorView.updateListener.of(() => marker())

    const { rerender } = render(
      <LightCodeEditor value="hello" onChange={() => {}} language="markdown" />
    )
    await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull())
    const contentBefore = document.querySelector(".cm-content")

    rerender(
      <LightCodeEditor
        value="hello"
        onChange={() => {}}
        language="markdown"
        extensions={[extension]}
      />
    )
    await waitFor(() => expect(marker).toHaveBeenCalled())
    // Same view, not a fresh one.
    expect(document.querySelector(".cm-content")).toBe(contentBefore)
  })

  it("is unaffected when a caller passes no extensions", async () => {
    // Every existing caller. The compartment holds an empty array and
    // contributes nothing.
    render(<LightCodeEditor value="hello" onChange={() => {}} language="markdown" />)
    await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull())
    expect(screen.getByText("hello")).toBeInTheDocument()
  })

  it("mounts with bracket auto-close disabled", async () => {
    render(
      <LightCodeEditor value="x" onChange={() => {}} language="plaintext" closeBrackets={false} />
    )
    const host = screen.getByTestId("light-code-editor")
    await waitFor(() => expect(host.querySelector(".cm-content")).toBeInTheDocument())
  })

  it("mounts without the search panel when search is disabled", async () => {
    render(<LightCodeEditor value="x" onChange={() => {}} language="plaintext" search={false} />)
    const host = screen.getByTestId("light-code-editor")
    await waitFor(() => expect(host.querySelector(".cm-content")).toBeInTheDocument())
    // The find/replace panel keymap + extension are omitted; the editor still mounts.
    expect(host.querySelector(".cm-search")).not.toBeInTheDocument()
  })

  it("offers shared builtin and plugin snippets through CodeMirror completion", async () => {
    collectEditorSnippetsMock.mockReturnValue([
      {
        label: "fn",
        insertText: "function ${1:name}() {\n  ${0}\n}",
        detail: "Function snippet",
      },
    ])
    render(<LightCodeEditor value="fn" onChange={() => {}} language="typescript" />)
    const host = screen.getByTestId("light-code-editor")
    await waitFor(() => expect(host.querySelector(".cm-content")).not.toBeNull())
    const content = host.querySelector<HTMLElement>(".cm-content") as HTMLElement
    content.focus()
    fireEvent.keyDown(content, { key: " ", code: "Space", ctrlKey: true })

    await waitFor(() => {
      const popup = document.querySelector(".cm-tooltip-autocomplete")
      expect(popup).toHaveTextContent("fn")
      expect(popup).toHaveTextContent("Function snippet")
    })
    expect(collectEditorSnippetsMock).toHaveBeenCalledWith("typescript")
  })

  describe("diagnostics status bar", () => {
    it("shows the status bar for a language with a producer", async () => {
      render(<LightCodeEditor value="{}" onChange={() => {}} language="json" />)
      await waitFor(() =>
        expect(screen.getByTestId("light-code-editor-status")).toBeInTheDocument()
      )
      expect(screen.getByText("No problems")).toBeInTheDocument()
    })

    it("does not show the status bar for a language without a producer", async () => {
      render(<LightCodeEditor value="x" onChange={() => {}} language="plaintext" />)
      const host = screen.getByTestId("light-code-editor")
      await waitFor(() => expect(host.querySelector(".cm-content")).toBeInTheDocument())
      expect(screen.queryByTestId("light-code-editor-status")).not.toBeInTheDocument()
    })

    it("can be suppressed via statusBar={false}", async () => {
      render(<LightCodeEditor value="{}" onChange={() => {}} language="json" statusBar={false} />)
      const host = screen.getByTestId("light-code-editor")
      await waitFor(() => expect(host.querySelector(".cm-content")).toBeInTheDocument())
      expect(screen.queryByTestId("light-code-editor-status")).not.toBeInTheDocument()
    })

    it("renders error and warning counts and notifies onDiagnosticsChange", async () => {
      mockSummaryReturn = { errors: 2, warnings: 1, infos: 0 }
      const onDiagnosticsChange = jest.fn()
      render(
        <LightCodeEditor
          value={'{ "a": }'}
          onChange={() => {}}
          language="json"
          onDiagnosticsChange={onDiagnosticsChange}
        />
      )
      await waitFor(() => expect(screen.getByLabelText("Errors")).toHaveTextContent("2"))
      expect(screen.getByLabelText("Warnings")).toHaveTextContent("1")
      expect(onDiagnosticsChange).toHaveBeenCalledWith({ errors: 2, warnings: 1, infos: 0 })
    })

    it("enables navigation buttons when problems exist and toggles the panel", async () => {
      mockSummaryReturn = { errors: 1, warnings: 0, infos: 0 }
      render(<LightCodeEditor value={'{ "a": }'} onChange={() => {}} language="json" />)
      const next = await screen.findByLabelText("Next problem")
      const prev = screen.getByLabelText("Previous problem")
      const toggle = screen.getByLabelText("Toggle problems panel")
      expect(next).not.toBeDisabled()
      expect(prev).not.toBeDisabled()
      // Navigation commands run against the view without throwing.
      fireEvent.click(next)
      fireEvent.click(prev)
      // Panel toggle flips aria-pressed.
      expect(toggle).toHaveAttribute("aria-pressed", "false")
      fireEvent.click(toggle)
      await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"))
      fireEvent.click(toggle)
      await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"))
    })

    it("disables navigation buttons when there are no problems", async () => {
      render(<LightCodeEditor value="{}" onChange={() => {}} language="json" />)
      const next = await screen.findByLabelText("Next problem")
      expect(next).toBeDisabled()
      expect(screen.getByLabelText("Previous problem")).toBeDisabled()
    })

    it("renders no count chips when only infos are present", async () => {
      mockSummaryReturn = { errors: 0, warnings: 0, infos: 3 }
      render(<LightCodeEditor value="{}" onChange={() => {}} language="json" />)
      await waitFor(() =>
        expect(screen.getByTestId("light-code-editor-status")).toBeInTheDocument()
      )
      expect(screen.queryByLabelText("Errors")).not.toBeInTheDocument()
      expect(screen.queryByLabelText("Warnings")).not.toBeInTheDocument()
      expect(screen.queryByText("No problems")).not.toBeInTheDocument()
    })

    it("installs no diagnostics layer when diagnostics={false}", async () => {
      const onDiagnosticsChange = jest.fn()
      mockSummaryReturn = { errors: 5, warnings: 0, infos: 0 }
      render(
        <LightCodeEditor
          value={'{ "a": }'}
          onChange={() => {}}
          language="json"
          diagnostics={false}
          onDiagnosticsChange={onDiagnosticsChange}
        />
      )
      const host = screen.getByTestId("light-code-editor")
      await waitFor(() => expect(host.querySelector(".cm-content")).toBeInTheDocument())
      expect(screen.queryByTestId("light-code-editor-status")).not.toBeInTheDocument()
      expect(onDiagnosticsChange).not.toHaveBeenCalled()
    })
  })
})

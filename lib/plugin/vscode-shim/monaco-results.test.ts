import {
  MONACO_MARKER_SEVERITY,
  monacoMarkersToVscodeDiagnostics,
  toMonacoCodeActions,
  toMonacoCompletions,
  toMonacoDocumentSymbols,
  toMonacoInlayHints,
  toMonacoMarkers,
  toMonacoSelectionRanges,
  toMonacoWorkspaceEdit,
  wordRangeBefore,
} from "./monaco-results"

const runtime = { parseUri: (uri: string) => ({ parsed: uri }) }
const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }

describe("monaco-results", () => {
  it("fills a missing completion range and keeps a stated one", () => {
    const fallback = { ...range, endColumn: 9 }
    expect(
      toMonacoCompletions({ suggestions: [{ label: "a" }, { label: "b", range }] }, fallback)
        .suggestions
    ).toEqual([
      { label: "a", range: fallback },
      { label: "b", range },
    ])
  })

  it("takes the word before the cursor, or an empty range when the model cannot say", () => {
    expect(
      wordRangeBefore(
        { getWordUntilPosition: () => ({ startColumn: 2, endColumn: 5 }) },
        {
          lineNumber: 3,
          column: 5,
        }
      )
    ).toEqual({ startLineNumber: 3, startColumn: 2, endLineNumber: 3, endColumn: 5 })
    expect(wordRangeBefore({}, { lineNumber: 3, column: 5 })).toEqual({
      startLineNumber: 3,
      startColumn: 5,
      endLineNumber: 3,
      endColumn: 5,
    })
  })

  it("splits workspace edits into one Monaco text edit per change", () => {
    expect(
      toMonacoWorkspaceEdit(runtime, {
        edits: [
          {
            resource: "file:///a",
            edits: [
              { range, text: "x" },
              { range, text: "y" },
            ],
          },
        ],
      }).edits
    ).toEqual([
      { resource: { parsed: "file:///a" }, textEdit: { range, text: "x" }, versionId: undefined },
      { resource: { parsed: "file:///a" }, textEdit: { range, text: "y" }, versionId: undefined },
    ])
  })

  it("gives nested symbols tags too", () => {
    const [symbol] = toMonacoDocumentSymbols([
      {
        name: "a",
        detail: "",
        kind: 4,
        range,
        selectionRange: range,
        children: [{ name: "b", detail: "", kind: 5, range, selectionRange: range }],
      },
    ])
    expect(symbol.tags).toEqual([])
    expect(symbol.children?.[0].tags).toEqual([])
  })

  it("maps inlay hint kinds to Monaco's enum and leaves unknown ones out", () => {
    expect(
      toMonacoInlayHints([
        { label: "a", position: { lineNumber: 1, column: 1 }, kind: "parameter" },
        { label: "b", position: { lineNumber: 1, column: 1 } },
      ]).hints
    ).toEqual([
      { label: "a", position: { lineNumber: 1, column: 1 }, kind: 2 },
      { label: "b", position: { lineNumber: 1, column: 1 } },
    ])
  })

  it("flattens each position's selection chain innermost first", () => {
    const outer = { ...range, endColumn: 20 }
    expect(toMonacoSelectionRanges([[{ range, parent: { range: outer } }]])).toEqual([
      [{ range }, { range: outer }],
    ])
  })

  it("keeps a disabled action's reason and a bare command's arguments", () => {
    expect(
      toMonacoCodeActions(runtime, [
        { title: "No", disabled: { reason: "not here" } },
        { title: "Go", command: "ext.go", arguments: ["x"] },
      ]).actions
    ).toEqual([
      { title: "No", disabled: "not here" },
      { title: "Go", command: { id: "ext.go", title: "Go", arguments: ["x"] } },
    ])
  })

  it("converts markers both ways between Monaco and VS Code severities", () => {
    const markers = toMonacoMarkers([
      { severity: "error", message: "e", range },
      { severity: "warning", message: "w", range },
      { severity: "info", message: "i", range },
      { severity: "hint", message: "h", range, source: "lint" },
    ])
    expect(markers.map((marker) => marker.severity)).toEqual([
      MONACO_MARKER_SEVERITY.error,
      MONACO_MARKER_SEVERITY.warning,
      MONACO_MARKER_SEVERITY.info,
      MONACO_MARKER_SEVERITY.hint,
    ])
    expect(markers[3]).toMatchObject({ source: "lint", ...range })
    expect(
      monacoMarkersToVscodeDiagnostics([
        ...markers,
        { ...markers[0], code: { value: "E1", target: {} } },
      ]).map((diagnostic) => [diagnostic.severity, diagnostic.code])
    ).toEqual([
      [0, undefined],
      [1, undefined],
      [2, undefined],
      [3, undefined],
      [0, "E1"],
    ])
  })
})

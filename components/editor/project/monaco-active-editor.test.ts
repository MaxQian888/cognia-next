import type { MonacoLike, RawMarker } from "@/hooks/use-monaco-markers"
import {
  readMonacoActiveEditor,
  type MonacoSelectionLike,
  type ReadableMonacoEditor,
} from "./monaco-active-editor"

const URI = { path: "/repo/src/a.ts" }

function fakeEditor(
  selection: MonacoSelectionLike | null,
  valueInRange = "selected",
  uri: unknown = URI
): ReadableMonacoEditor {
  return {
    getSelection: () => selection,
    getModel: () => ({ uri, getValueInRange: () => valueInRange }),
  }
}

function fakeMonaco(
  markers: RawMarker[],
  onFilter?: (f: { resource?: unknown }) => void
): MonacoLike {
  return {
    editor: {
      getModelMarkers: (filter) => {
        onFilter?.(filter)
        return markers
      },
      onDidChangeMarkers: () => ({ dispose: () => {} }),
    },
  }
}

const marker = (over: Partial<RawMarker> = {}): RawMarker => ({
  severity: 8,
  message: "boom",
  startLineNumber: 3,
  startColumn: 5,
  endLineNumber: 3,
  endColumn: 9,
  ...over,
})

it("maps a non-empty selection to the 1-based canonical range plus its text", () => {
  const result = readMonacoActiveEditor({
    path: "/repo/src/a.ts",
    openEditors: ["/repo/src/a.ts", "/repo/src/b.ts"],
    editor: fakeEditor(
      { startLineNumber: 2, startColumn: 1, endLineNumber: 4, endColumn: 7 },
      "chunk"
    ),
    monaco: fakeMonaco([]),
  })

  expect(result).toEqual({
    path: "/repo/src/a.ts",
    selection: { startLine: 2, startColumn: 1, endLine: 4, endColumn: 7 },
    selectedText: "chunk",
    diagnostics: [],
    openEditors: ["/repo/src/a.ts", "/repo/src/b.ts"],
  })
})

it("reports a bare caret as a selection with no selected text", () => {
  // code-server returns `selectedText: null` for an empty range. Monaco would
  // happily return "", which reads to the model as "the user selected nothing
  // in particular" rather than "the user selected nothing".
  const result = readMonacoActiveEditor({
    path: "/repo/src/a.ts",
    openEditors: ["/repo/src/a.ts"],
    editor: fakeEditor({ startLineNumber: 6, startColumn: 3, endLineNumber: 6, endColumn: 3 }, ""),
    monaco: fakeMonaco([]),
  })

  expect(result.selection).toEqual({ startLine: 6, startColumn: 3, endLine: 6, endColumn: 3 })
  expect(result.selectedText).toBeNull()
})

it("maps Monaco's numeric severities onto the canonical names", () => {
  const result = readMonacoActiveEditor({
    path: "/repo/src/a.ts",
    openEditors: [],
    editor: fakeEditor(null),
    monaco: fakeMonaco([
      marker({ severity: 8, message: "err" }),
      marker({ severity: 4, message: "warn" }),
      marker({ severity: 2, message: "info" }),
      marker({ severity: 1, message: "hint" }),
    ]),
  })

  expect(result.diagnostics.map((d) => [d.message, d.severity])).toEqual([
    ["err", "error"],
    ["warn", "warning"],
    ["info", "info"],
    ["hint", "hint"],
  ])
})

it("takes a diagnostic's position from the start of its range", () => {
  const result = readMonacoActiveEditor({
    path: "/repo/src/a.ts",
    openEditors: [],
    editor: fakeEditor(null),
    monaco: fakeMonaco([marker({ startLineNumber: 11, startColumn: 4 })]),
  })

  expect(result.diagnostics[0]).toMatchObject({ line: 11, column: 4 })
})

it("filters markers to the focused model's own resource", () => {
  // Unfiltered, Monaco hands back every open model's markers — which would
  // attribute another file's errors to the file the user is looking at.
  const seen: Array<{ resource?: unknown }> = []
  readMonacoActiveEditor({
    path: "/repo/src/a.ts",
    openEditors: [],
    editor: fakeEditor(null),
    monaco: fakeMonaco([], (filter) => seen.push(filter)),
  })

  expect(seen).toEqual([{ resource: URI }])
})

it("yields the empty snapshot before Monaco has mounted", () => {
  // Same shape code-server produces with no editor open, so callers never need
  // an engine-specific branch for the not-yet-ready case.
  expect(
    readMonacoActiveEditor({ path: null, openEditors: [], editor: null, monaco: null })
  ).toEqual({
    path: null,
    selection: null,
    selectedText: null,
    diagnostics: [],
    openEditors: [],
  })
})

it("skips markers when the editor has a selection but no model yet", () => {
  const editor: ReadableMonacoEditor = {
    getSelection: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }),
    getModel: () => null,
  }

  const result = readMonacoActiveEditor({
    path: null,
    openEditors: [],
    editor,
    monaco: fakeMonaco([marker()]),
  })

  expect(result.diagnostics).toEqual([])
  expect(result.selectedText).toBeNull()
  // The range is still reported: the caret position is real even mid-swap.
  expect(result.selection).toEqual({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 })
})

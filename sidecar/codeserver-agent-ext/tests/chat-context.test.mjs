import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  MAX_CHAT_SNAPSHOT_CHARS,
  captureChatContext,
  captureDiagnosticsContext,
  captureFileContext,
} from "../src/chat-context.mjs"

// The real capture functions, run against a fake `vscode` they receive as a
// parameter — the previous suite re-implemented them inline and tested the copy.

function range(startLine, startCharacter, endLine, endCharacter) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  }
}

function selection(startLine, startCharacter, endLine, endCharacter) {
  const r = range(startLine, startCharacter, endLine, endCharacter)
  const isEmpty = startLine === endLine && startCharacter === endCharacter
  const within = (line) => line >= startLine && line <= endLine
  return {
    ...r,
    isEmpty,
    contains: (other) => within(other.start.line) && within(other.end.line),
    intersection: (other) =>
      other.start.line <= endLine && other.end.line >= startLine ? other : undefined,
  }
}

const fileUri = (fsPath) => ({ scheme: "file", fsPath })

function fakeVscode({ editor = null, diagnostics = [], allDiagnostics = [] } = {}) {
  return {
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    window: { activeTextEditor: editor },
    workspace: {
      asRelativePath: (uri) => uri.fsPath.replace("/work/proj/", ""),
    },
    languages: {
      getDiagnostics: (uri) => (uri ? diagnostics : allDiagnostics),
    },
  }
}

function editorWith(sel, text = "const x = 1;\nreturn x") {
  return {
    selection: sel,
    document: {
      uri: fileUri("/work/proj/src/index.ts"),
      languageId: "typescript",
      getText: (r) => (r ? text : "full file text"),
    },
  }
}

const diagnostics = [
  { message: "unused variable", severity: 1, range: range(10, 0, 10, 5) },
  { message: "type error", severity: 0, range: range(12, 0, 12, 10) },
  { message: "far away issue", severity: 0, range: range(50, 0, 50, 5) },
]

describe("captureChatContext", () => {
  test("returns null with no active editor or a non-file editor", () => {
    assert.equal(captureChatContext(fakeVscode(), "explain"), null)
    const untitled = {
      selection: selection(0, 0, 0, 0),
      document: { uri: { scheme: "untitled", fsPath: "" }, languageId: "ts", getText: () => "" },
    }
    assert.equal(captureChatContext(fakeVscode({ editor: untitled }), "explain"), null)
  })

  test("captures a 1-based selection, its text and the diagnostics inside it", () => {
    const vscode = fakeVscode({ editor: editorWith(selection(9, 0, 14, 19)), diagnostics })
    assert.deepEqual(captureChatContext(vscode, "explain"), {
      action: "explain",
      path: "/work/proj/src/index.ts",
      relativePath: "src/index.ts",
      language: "typescript",
      selection: { startLine: 10, startColumn: 1, endLine: 15, endColumn: 20 },
      selectedText: "const x = 1;\nreturn x",
      truncated: false,
      diagnostics: [
        { message: "unused variable", severity: "warning", line: 11 },
        { message: "type error", severity: "error", line: 13 },
      ],
    })
  })

  test("an empty selection carries no text and no diagnostics", () => {
    const vscode = fakeVscode({ editor: editorWith(selection(5, 0, 5, 0)), diagnostics })
    const ctx = captureChatContext(vscode, "addFile")
    assert.equal(ctx.selection, null)
    assert.equal(ctx.selectedText, null)
    assert.deepEqual(ctx.diagnostics, [])
  })

  test("truncates a selection past the snapshot limit and says so", () => {
    const long = "x".repeat(MAX_CHAT_SNAPSHOT_CHARS + 10)
    const vscode = fakeVscode({ editor: editorWith(selection(0, 0, 3, 0), long) })
    const ctx = captureChatContext(vscode, "review")
    assert.equal(ctx.selectedText.length, MAX_CHAT_SNAPSHOT_CHARS)
    assert.equal(ctx.truncated, true)
  })
})

describe("captureFileContext", () => {
  test("captures a file URI without selection data", () => {
    assert.deepEqual(captureFileContext(fakeVscode(), fileUri("/work/proj/src/utils.ts")), {
      action: "addFile",
      path: "/work/proj/src/utils.ts",
      relativePath: "src/utils.ts",
      language: null,
      selection: null,
      selectedText: null,
      truncated: false,
      diagnostics: [],
    })
  })

  test("ignores non-file URIs", () => {
    assert.equal(captureFileContext(fakeVscode(), { scheme: "git", fsPath: "/x" }), null)
    assert.equal(captureFileContext(fakeVscode(), null), null)
  })
})

describe("captureDiagnosticsContext", () => {
  test("hands over errors and warnings with 1-based positions", () => {
    const vscode = fakeVscode({
      allDiagnostics: [
        [
          fileUri("/work/proj/a.ts"),
          [
            { message: "first line", severity: 0, range: range(0, 0, 0, 1) },
            { message: "tenth line", severity: 1, range: range(9, 4, 9, 6) },
            { message: "a hint", severity: 3, range: range(2, 0, 2, 1) },
          ],
        ],
        [fileUri("/work/proj/b.ts"), [{ message: "info", severity: 2, range: range(1, 0, 1, 1) }]],
      ],
    })
    assert.deepEqual(captureDiagnosticsContext(vscode), {
      total: 2,
      files: [
        {
          path: "/work/proj/a.ts",
          relativePath: "a.ts",
          diagnostics: [
            { message: "first line", severity: "error", line: 1, column: 1 },
            // A 0-based line 9 is line 10 to a person; the old capture said 9.
            { message: "tenth line", severity: "warning", line: 10, column: 5 },
          ],
        },
      ],
    })
  })

  test("returns null when nothing worth sending is reported", () => {
    const vscode = fakeVscode({
      allDiagnostics: [
        [fileUri("/work/proj/a.ts"), [{ message: "h", severity: 3, range: range(0, 0, 0, 1) }]],
      ],
    })
    assert.equal(captureDiagnosticsContext(vscode), null)
  })
})

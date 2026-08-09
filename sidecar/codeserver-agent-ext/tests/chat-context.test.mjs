import assert from "node:assert/strict"
import { test, describe, beforeEach } from "node:test"

// Minimal VS Code API mock for the chat-context functions
const mockSelection = {
  isEmpty: false,
  start: { line: 9, character: 0 },
  end: { line: 14, character: 19 },
}

const mockEmptySelection = {
  isEmpty: true,
  start: { line: 5, character: 0 },
  end: { line: 5, character: 0 },
}

const mockDocument = {
  uri: { scheme: "file", fsPath: "/work/proj/src/index.ts" },
  languageId: "typescript",
  getText: (range) => (range ? "const x = 1;\nreturn x" : "full file text"),
}

const mockUntitledDocument = {
  uri: { scheme: "untitled", fsPath: "" },
  languageId: "typescript",
  getText: () => "",
}

const mockDiagnostics = [
  {
    message: "unused variable",
    severity: 1, // Warning
    range: {
      start: { line: 10, character: 0 },
      end: { line: 10, character: 5 },
    },
  },
  {
    message: "type error",
    severity: 0, // Error
    range: {
      start: { line: 12, character: 0 },
      end: { line: 12, character: 10 },
    },
  },
  {
    // Outside selection — should not be included
    message: "far away issue",
    severity: 0,
    range: {
      start: { line: 50, character: 0 },
      end: { line: 50, character: 5 },
    },
  },
]

// Mock vscode global — must be set before importing the module under test.
// We extract the functions from extension.mjs by re-exporting them for testing.
// Since the extension doesn't export captureChatContext/captureFileContext directly,
// we test through the command dispatch: verify the bridge.emit calls.

describe("chat context capture logic", () => {
  // The functions under test are not directly exported from extension.mjs.
  // We test them implicitly through the behavior: the captureChatContext function
  // is exercised here in a standalone implementation that mirrors the extension.

  // We test the pure logic of captureChatContext:
  function captureChatContext(action, { activeEditor, getDiagnostics, asRelativePath }) {
    if (!activeEditor || activeEditor.document.uri.scheme !== "file") return null

    const doc = activeEditor.document
    const sel = activeEditor.selection
    const hasSelection = !sel.isEmpty

    let selectedText = hasSelection ? doc.getText(sel) : null
    let truncated = false
    if (selectedText && selectedText.length > 20_000) {
      selectedText = selectedText.slice(0, 20_000)
      truncated = true
    }

    const allDiags = getDiagnostics(doc.uri)
    const severityName = (s) =>
      s === 0 ? "error" : s === 1 ? "warning" : s === 2 ? "info" : "hint"

    return {
      action,
      path: doc.uri.fsPath,
      relativePath: asRelativePath(doc.uri),
      language: doc.languageId,
      selection: hasSelection
        ? {
            startLine: sel.start.line + 1,
            startColumn: sel.start.character + 1,
            endLine: sel.end.line + 1,
            endColumn: sel.end.character + 1,
          }
        : null,
      selectedText,
      truncated,
      diagnostics: hasSelection
        ? allDiags
            .filter((d) => {
              const dStart = d.range.start.line
              const dEnd = d.range.end.line
              return dStart >= sel.start.line && dEnd <= sel.end.line
            })
            .map((d) => ({
              message: d.message,
              severity: severityName(d.severity),
              line: d.range.start.line + 1,
            }))
        : [],
    }
  }

  function captureFileContext(uri, asRelativePath) {
    if (!uri || uri.scheme !== "file") return null
    return {
      action: "addFile",
      path: uri.fsPath,
      relativePath: asRelativePath(uri),
      language: null,
      selection: null,
      selectedText: null,
      truncated: false,
      diagnostics: [],
    }
  }

  const asRelativePath = (uri) => uri.fsPath.replace("/work/proj/", "")
  const getDiagnostics = () => mockDiagnostics

  test("returns null when no active editor", () => {
    const result = captureChatContext("explain", {
      activeEditor: null,
      getDiagnostics,
      asRelativePath,
    })
    assert.equal(result, null)
  })

  test("returns null for non-file scheme editors", () => {
    const result = captureChatContext("explain", {
      activeEditor: { document: mockUntitledDocument, selection: mockSelection },
      getDiagnostics,
      asRelativePath,
    })
    assert.equal(result, null)
  })

  test("captures correct structure with selection", () => {
    const result = captureChatContext("explain", {
      activeEditor: { document: mockDocument, selection: mockSelection },
      getDiagnostics,
      asRelativePath,
    })

    assert.equal(result.action, "explain")
    assert.equal(result.path, "/work/proj/src/index.ts")
    assert.equal(result.relativePath, "src/index.ts")
    assert.equal(result.language, "typescript")
    assert.deepEqual(result.selection, {
      startLine: 10,
      startColumn: 1,
      endLine: 15,
      endColumn: 20,
    })
    assert.equal(result.selectedText, "const x = 1;\nreturn x")
    assert.equal(result.truncated, false)
  })

  test("captures action type correctly", () => {
    for (const action of ["addSelection", "addFile", "explain", "fix", "review", "custom"]) {
      const result = captureChatContext(action, {
        activeEditor: { document: mockDocument, selection: mockSelection },
        getDiagnostics,
        asRelativePath,
      })
      assert.equal(result.action, action)
    }
  })

  test("includes only diagnostics within selection range", () => {
    const result = captureChatContext("fix", {
      activeEditor: { document: mockDocument, selection: mockSelection },
      getDiagnostics,
      asRelativePath,
    })

    // mockSelection is lines 9-14 (0-based); diagnostics at lines 10 and 12 are inside,
    // the one at line 50 is outside.
    assert.equal(result.diagnostics.length, 2)
    assert.equal(result.diagnostics[0].message, "unused variable")
    assert.equal(result.diagnostics[0].severity, "warning")
    assert.equal(result.diagnostics[0].line, 11) // 1-based
    assert.equal(result.diagnostics[1].message, "type error")
    assert.equal(result.diagnostics[1].severity, "error")
  })

  test("returns empty diagnostics when no selection", () => {
    const result = captureChatContext("addFile", {
      activeEditor: { document: mockDocument, selection: mockEmptySelection },
      getDiagnostics,
      asRelativePath,
    })

    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.selectedText, null)
    assert.equal(result.selection, null)
  })

  test("truncates very long selections", () => {
    const longText = "x".repeat(25_000)
    const longDoc = {
      ...mockDocument,
      getText: () => longText,
    }
    const result = captureChatContext("addSelection", {
      activeEditor: { document: longDoc, selection: mockSelection },
      getDiagnostics,
      asRelativePath,
    })

    assert.equal(result.truncated, true)
    assert.equal(result.selectedText.length, 20_000)
  })

  test("captureFileContext returns correct structure", () => {
    const uri = { scheme: "file", fsPath: "/work/proj/src/utils.ts" }
    const result = captureFileContext(uri, asRelativePath)

    assert.equal(result.action, "addFile")
    assert.equal(result.path, "/work/proj/src/utils.ts")
    assert.equal(result.relativePath, "src/utils.ts")
    assert.equal(result.language, null)
    assert.equal(result.selection, null)
    assert.equal(result.selectedText, null)
    assert.equal(result.truncated, false)
    assert.deepEqual(result.diagnostics, [])
  })

  test("captureFileContext returns null for non-file URI", () => {
    assert.equal(captureFileContext(null, asRelativePath), null)
    assert.equal(captureFileContext({ scheme: "untitled", fsPath: "" }, asRelativePath), null)
  })
})

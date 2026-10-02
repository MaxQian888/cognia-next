import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { createLspConverters } from "../src/lsp-converters.mjs"

// Just enough of VS Code's value types to see what the converters built.
const record = (name, fields) =>
  class {
    constructor(...args) {
      this.$type = name
      fields.forEach((field, index) => {
        if (args[index] !== undefined) this[field] = args[index]
      })
    }
  }

class Position {
  constructor(line, character) {
    Object.assign(this, { line, character })
  }
}
class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = new Position(startLine, startCharacter)
    this.end = new Position(endLine, endCharacter)
  }
  // VS Code's: an array, which is why ranges are never sent with `plain()`.
  toJSON() {
    return [this.start, this.end]
  }
}
class MarkdownString {
  constructor(value = "") {
    this.value = value
  }
  appendText(text) {
    this.value += text
    return this
  }
  appendCodeblock(code, language) {
    this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`
    return this
  }
}
class CodeActionKind {
  constructor(value) {
    this.value = value
  }
  append(part) {
    return new CodeActionKind(this.value ? `${this.value}.${part}` : part)
  }
}
CodeActionKind.Empty = new CodeActionKind("")

const vscode = {
  Uri: { parse: (value) => ({ $uri: value, toString: () => value }) },
  Position,
  Range,
  MarkdownString,
  CodeActionKind,
  Location: record("Location", ["uri", "range"]),
  Hover: record("Hover", ["contents", "range"]),
  CompletionItem: record("CompletionItem", ["label", "kind"]),
  CompletionList: record("CompletionList", ["items", "isIncomplete"]),
  SnippetString: record("SnippetString", ["value"]),
  TextEdit: { replace: (range, newText) => ({ $type: "TextEdit", range, newText }) },
  Diagnostic: record("Diagnostic", ["range", "message", "severity"]),
  DiagnosticRelatedInformation: record("DiagnosticRelatedInformation", ["location", "message"]),
  DiagnosticSeverity: { Error: 0 },
  DocumentHighlight: record("DocumentHighlight", ["range", "kind"]),
  DocumentSymbol: record("DocumentSymbol", ["name", "detail", "kind", "range", "selectionRange"]),
  SymbolInformation: record("SymbolInformation", ["name", "kind", "containerName", "location"]),
  CodeAction: record("CodeAction", ["title", "kind"]),
  CodeLens: record("CodeLens", ["range", "command"]),
  DocumentLink: record("DocumentLink", ["range", "target"]),
  Color: record("Color", ["red", "green", "blue", "alpha"]),
  ColorInformation: record("ColorInformation", ["range", "color"]),
  ColorPresentation: record("ColorPresentation", ["label"]),
  FoldingRange: record("FoldingRange", ["start", "end", "kind"]),
  FoldingRangeKind: { Comment: 1, Imports: 2, Region: 3 },
  SelectionRange: record("SelectionRange", ["range", "parent"]),
  SignatureHelp: record("SignatureHelp", []),
  SignatureInformation: record("SignatureInformation", ["label", "documentation"]),
  ParameterInformation: record("ParameterInformation", ["label", "documentation"]),
  InlineValueText: record("InlineValueText", ["range", "text"]),
  InlineValueVariableLookup: record("InlineValueVariableLookup", [
    "range",
    "variableName",
    "caseSensitiveLookup",
  ]),
  InlineValueEvaluatableExpression: record("InlineValueEvaluatableExpression", [
    "range",
    "expression",
  ]),
  InlayHint: record("InlayHint", ["position", "label", "kind"]),
  InlayHintLabelPart: record("InlayHintLabelPart", ["value"]),
  LinkedEditingRanges: record("LinkedEditingRanges", ["ranges", "wordPattern"]),
  CallHierarchyItem: record("CallHierarchyItem", [
    "kind",
    "name",
    "detail",
    "uri",
    "range",
    "selectionRange",
  ]),
  CallHierarchyIncomingCall: record("CallHierarchyIncomingCall", ["from", "fromRanges"]),
  CallHierarchyOutgoingCall: record("CallHierarchyOutgoingCall", ["to", "fromRanges"]),
  TypeHierarchyItem: record("TypeHierarchyItem", [
    "kind",
    "name",
    "detail",
    "uri",
    "range",
    "selectionRange",
  ]),
}

const lspRange = (line, start, end = start) => ({
  start: { line, character: start },
  end: { line, character: end },
})
const convert = createLspConverters(vscode)

describe("protocol → code", () => {
  test("a hover's MarkupContent, MarkedString and legacy code block become MarkdownStrings", () => {
    const hover = convert.hover({
      contents: { kind: "markdown", value: "**bold**" },
      range: lspRange(1, 2, 5),
    })
    assert.equal(hover.$type, "Hover")
    assert.ok(hover.contents[0] instanceof MarkdownString)
    assert.equal(hover.contents[0].value, "**bold**")
    assert.ok(hover.range instanceof Range)
    const legacy = convert.hover({ contents: ["plain", { language: "ts", value: "let a" }] })
    assert.equal(legacy.contents[0].value, "plain")
    assert.match(legacy.contents[1].value, /```ts\nlet a\n```/)
    assert.equal(
      convert.hover({ contents: { kind: "plaintext", value: "*x*" } }).contents[0].value,
      "*x*"
    )
    assert.equal(convert.hover(null), undefined)
  })

  test("definitions keep links as links and locations as Locations", () => {
    const [link, location] = convert.definition([
      {
        targetUri: "file:///a.ts",
        targetRange: lspRange(3, 0, 9),
        targetSelectionRange: lspRange(3, 4, 7),
        originSelectionRange: lspRange(0, 1, 2),
      },
      { uri: "file:///b.ts", range: lspRange(4, 0) },
    ])
    assert.equal(link.targetUri.toString(), "file:///a.ts")
    assert.equal(link.targetSelectionRange.start.character, 4)
    assert.equal(location.$type, "Location")
    assert.equal(location.uri.toString(), "file:///b.ts")
    assert.equal(convert.definition({ uri: "file:///c.ts", range: lspRange(0, 0) }).length, 1)
  })

  test("completion kinds shift from LSP's 1-based numbering, snippets and edits come across", () => {
    const list = convert.completion({
      isIncomplete: true,
      itemDefaults: { editRange: lspRange(2, 0, 3), insertTextFormat: 2 },
      items: [
        { label: "log", kind: 2, insertText: "log($1)", data: { id: 7 } },
        {
          label: "fn",
          labelDetails: { detail: "()", description: "module" },
          kind: 3,
          insertTextFormat: 1,
          textEdit: {
            newText: "fn()",
            insert: lspRange(2, 0, 1),
            replace: lspRange(2, 0, 3),
          },
          documentation: { kind: "markdown", value: "docs" },
          additionalTextEdits: [{ range: lspRange(0, 0), newText: "import x\n" }],
          command: { title: "t", command: "c.run", arguments: [1] },
        },
      ],
    })
    assert.equal(list.$type, "CompletionList")
    assert.equal(list.isIncomplete, true)
    const [snippet, edited] = list.items
    // LSP Method = 2 → VS Code Method = 1.
    assert.equal(snippet.kind, 1)
    assert.equal(snippet.insertText.$type, "SnippetString")
    assert.equal(snippet.range.end.character, 3)
    assert.deepEqual(convert.originOf(snippet).data, { id: 7 })
    assert.deepEqual(edited.label, { label: "fn", detail: "()", description: "module" })
    assert.equal(edited.insertText, "fn()")
    assert.equal(edited.range.inserting.end.character, 1)
    assert.equal(edited.range.replacing.end.character, 3)
    assert.equal(edited.documentation.value, "docs")
    assert.equal(edited.additionalTextEdits[0].newText, "import x\n")
    assert.deepEqual(edited.command, { title: "t", command: "c.run", arguments: [1] })
    assert.equal(convert.completion([{ label: "x" }])[0].insertText, "x")
  })

  test("diagnostics shift severity and keep their code target and related information", () => {
    const diagnostic = convert.diagnostic({
      range: lspRange(0, 0, 4),
      message: "bad",
      severity: 1,
      code: "E1",
      codeDescription: { href: "https://example.test/E1" },
      source: "fixture",
      tags: [1],
      relatedInformation: [
        { location: { uri: "file:///a.ts", range: lspRange(1, 0) }, message: "here" },
      ],
      data: { fix: 1 },
    })
    // LSP Error = 1 → VS Code Error = 0.
    assert.equal(diagnostic.severity, 0)
    assert.equal(diagnostic.code.value, "E1")
    assert.equal(diagnostic.code.target.toString(), "https://example.test/E1")
    assert.equal(diagnostic.relatedInformation[0].message, "here")
    // The server's own value travels back inside a code action context.
    assert.deepEqual(convert.toDiagnostic(diagnostic).data, { fix: 1 })
    assert.equal(
      convert.diagnostic({ range: lspRange(0, 0), message: "m", severity: 4 }).severity,
      3
    )
  })

  test("document symbols nest; flat SymbolInformation stays flat", () => {
    const [symbol] = convert.documentSymbols([
      {
        name: "Outer",
        kind: 5,
        range: lspRange(0, 0, 9),
        selectionRange: lspRange(0, 6, 11),
        children: [
          { name: "inner", kind: 6, range: lspRange(1, 2), selectionRange: lspRange(1, 2) },
        ],
      },
    ])
    // LSP Class = 5 → VS Code Class = 4.
    assert.equal(symbol.kind, 4)
    assert.equal(symbol.children[0].name, "inner")
    const [flat] = convert.documentSymbols([
      {
        name: "f",
        kind: 12,
        containerName: "m",
        location: { uri: "file:///a.ts", range: lspRange(2, 0) },
      },
    ])
    assert.equal(flat.$type, "SymbolInformation")
    assert.equal(flat.kind, 11)
    const [lazy] = convert.workspaceSymbols([
      { name: "w", kind: 1, location: { uri: "file:///w.ts" } },
    ])
    assert.equal(lazy.location.uri.toString(), "file:///w.ts")
  })

  test("code actions and bare commands, with edits revived by the caller", () => {
    const [bare, action] = convert.codeActions(
      [
        { title: "Run", command: "acme.run", arguments: [] },
        {
          title: "Fix",
          kind: "quickfix",
          isPreferred: true,
          diagnostics: [{ range: lspRange(0, 0), message: "m", severity: 2 }],
          edit: { changes: {} },
          command: { title: "after", command: "acme.after" },
          data: 3,
        },
      ],
      (edit) => ({ revived: edit })
    )
    assert.deepEqual(bare, { title: "Run", command: "acme.run", arguments: [] })
    assert.equal(action.kind.value, "quickfix")
    assert.equal(action.isPreferred, true)
    assert.equal(action.diagnostics[0].severity, 1)
    assert.deepEqual(action.edit, { revived: { changes: {} } })
    assert.equal(action.command.command, "acme.after")
    assert.equal(convert.originOf(action).data, 3)
  })

  test("lenses, links, colors, highlights and folding", () => {
    const [lens] = convert.codeLenses([{ range: lspRange(0, 0), data: 1 }])
    assert.equal(lens.command, undefined)
    assert.equal(convert.originOf(lens).data, 1)
    const [link] = convert.documentLinks([
      { range: lspRange(0, 0), target: "https://x.test", tooltip: "t" },
    ])
    assert.equal(link.target.toString(), "https://x.test")
    const [color] = convert.colorInformation([
      { range: lspRange(0, 0), color: { red: 1, green: 0, blue: 0, alpha: 1 } },
    ])
    assert.equal(color.color.red, 1)
    const [presentation] = convert.colorPresentations([
      { label: "red", textEdit: { range: lspRange(0, 0), newText: "#f00" } },
    ])
    assert.equal(presentation.textEdit.newText, "#f00")
    const [highlight] = convert.documentHighlights([{ range: lspRange(0, 0), kind: 3 }])
    // LSP Write = 3 → VS Code Write = 2.
    assert.equal(highlight.kind, 2)
    const folds = convert.foldingRanges([
      { startLine: 0, endLine: 3, kind: "imports" },
      { startLine: 4, endLine: 5 },
    ])
    assert.equal(folds[0].kind, 2)
    assert.equal(folds[1].kind, undefined)
  })

  test("rename preparation follows the three LSP answers", () => {
    assert.ok(convert.prepareRename(lspRange(0, 1, 4)) instanceof Range)
    assert.equal(
      convert.prepareRename({ range: lspRange(0, 1, 4), placeholder: "x" }).placeholder,
      "x"
    )
    assert.equal(convert.prepareRename({ defaultBehavior: true }), undefined)
    assert.throws(() => convert.prepareRename(null), /can't be renamed/)
  })

  test("signature help, inline values, inlay hints and linked editing", () => {
    const help = convert.signatureHelp({
      signatures: [
        {
          label: "f(a, b)",
          documentation: "doc",
          parameters: [
            { label: [2, 3] },
            { label: "b", documentation: { kind: "markdown", value: "B" } },
          ],
          activeParameter: 1,
        },
      ],
      activeSignature: 0,
      activeParameter: 1,
    })
    assert.equal(help.signatures[0].documentation, "doc")
    assert.deepEqual(help.signatures[0].parameters[0].label, [2, 3])
    assert.equal(help.signatures[0].parameters[1].documentation.value, "B")
    assert.equal(help.activeParameter, 1)

    const [text, lookup, expression] = convert.inlineValues([
      { range: lspRange(0, 0), text: "x = 1" },
      { range: lspRange(1, 0), caseSensitiveLookup: false },
      { range: lspRange(2, 0), expression: "a.b" },
    ])
    assert.equal(text.$type, "InlineValueText")
    assert.equal(lookup.$type, "InlineValueVariableLookup")
    assert.equal(lookup.caseSensitiveLookup, false)
    assert.equal(expression.expression, "a.b")

    const [hint] = convert.inlayHints([
      {
        position: { line: 3, character: 4 },
        label: [{ value: ": number", location: { uri: "file:///t.ts", range: lspRange(0, 0) } }],
        kind: 1,
        paddingLeft: true,
        data: "h",
      },
    ])
    assert.equal(hint.position.line, 3)
    assert.equal(hint.label[0].value, ": number")
    assert.equal(hint.paddingLeft, true)
    assert.equal(convert.originOf(hint).data, "h")

    const linked = convert.linkedEditingRanges({ ranges: [lspRange(0, 1, 4)], wordPattern: "\\w+" })
    assert.ok(linked.wordPattern instanceof RegExp)
  })

  test("hierarchy items round-trip the server's own item", () => {
    const original = {
      name: "f",
      kind: 12,
      uri: "file:///a.ts",
      range: lspRange(0, 0, 9),
      selectionRange: lspRange(0, 0, 1),
      data: { id: 1 },
    }
    const [item] = convert.callHierarchyItems([original])
    assert.equal(item.kind, 11)
    assert.equal(convert.toHierarchyItem(item), original)
    const [incoming] = convert.incomingCalls([{ from: original, fromRanges: [lspRange(4, 2)] }])
    assert.equal(incoming.from.name, "f")
    const [outgoing] = convert.outgoingCalls([{ to: original, fromRanges: [] }])
    assert.equal(outgoing.to.name, "f")
    assert.equal(convert.typeHierarchyItems([original])[0].$type, "TypeHierarchyItem")
  })
})

describe("code → protocol", () => {
  test("ranges are objects, never VS Code's toJSON array", () => {
    assert.deepEqual(convert.toRange(new Range(1, 2, 3, 4)), {
      start: { line: 1, character: 2 },
      end: { line: 3, character: 4 },
    })
  })

  test("trigger kinds and diagnostics are renumbered for LSP", () => {
    assert.deepEqual(convert.toCompletionContext({ triggerKind: 1, triggerCharacter: "." }), {
      triggerKind: 2,
      triggerCharacter: ".",
    })
    assert.deepEqual(convert.toCompletionContext(undefined), { triggerKind: 1 })
    const vscodeDiagnostic = new vscode.Diagnostic(new Range(0, 0, 0, 1), "m", 1)
    vscodeDiagnostic.code = { value: "E2", target: {} }
    assert.deepEqual(
      convert.toCodeActionContext({
        diagnostics: [vscodeDiagnostic],
        only: new CodeActionKind("refactor"),
        triggerKind: 1,
      }),
      {
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            message: "m",
            severity: 2,
            code: "E2",
          },
        ],
        only: ["refactor"],
        triggerKind: 1,
      }
    )
  })

  test("signature help context sends back the server's own active help", () => {
    const original = { signatures: [{ label: "f()" }], activeSignature: 0, activeParameter: 0 }
    const help = convert.signatureHelp(original)
    assert.deepEqual(
      convert.toSignatureHelpContext({
        triggerKind: 2,
        triggerCharacter: "(",
        isRetrigger: true,
        activeSignatureHelp: help,
      }),
      { triggerKind: 2, isRetrigger: true, triggerCharacter: "(", activeSignatureHelp: original }
    )
    assert.deepEqual(
      convert.toInlineValueContext({ frameId: 3, stoppedLocation: new Range(1, 0, 1, 2) }),
      {
        frameId: 3,
        stoppedLocation: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } },
      }
    )
  })
})

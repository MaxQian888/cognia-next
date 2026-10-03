import assert from "node:assert/strict"
import { test } from "node:test"

const wire = await import("../dist/vscode-shim/provider-wire.js")
const { encodeRegExps, globToRegExp, matchSelector, wireSelector } =
  await import("../dist/vscode-shim/languages.js")
const { TextDocument } = await import("../dist/vscode-shim/documents.js")
const api = await import("../dist/vscode-shim/api-types.js")
const { CompletionItemKind, MarkdownString, Position, Range, Uri, WorkspaceEdit, TextEdit } =
  await import("../dist/vscode-shim/types.js")

const r = (a, b, c, d) => ({ start: { line: a, character: b }, end: { line: c, character: d } })

test("arguments become VS Code objects", () => {
  assert.ok(wire.toRange(r(0, 1, 2, 3)) instanceof Range)
  const [diagnostic] = wire.toDiagnostics([
    { range: r(0, 0, 0, 1), message: "m", severity: 1, code: 7 },
  ])
  assert.ok(diagnostic instanceof api.Diagnostic)
  assert.equal(diagnostic.code, 7)
  assert.ok(wire.toCodeActionKind("refactor.extract").intersects(api.CodeActionKind.Refactor))
  assert.equal(wire.toCodeActionKind(undefined), undefined)
  assert.equal(wire.toColor({ red: 1, green: 0, blue: 0, alpha: 1 }).red, 1)
})

test("completions: LSP kinds, snippets, insert/replace ranges, commands", () => {
  const item = new api.CompletionItem({ label: "x", detail: "(a)" }, CompletionItemKind.Function)
  item.insertText = new api.SnippetString("x($1)")
  item.range = { inserting: new Range(0, 0, 0, 1), replacing: new Range(0, 0, 0, 2) }
  item.command = { command: "c", title: "T" }
  assert.deepEqual(wire.wireCompletions([item, { label: "plain", insertText: "p" }]), [
    {
      label: { label: "x", detail: "(a)" },
      kind: CompletionItemKind.Function + 1,
      insertText: "x($1)",
      insertTextFormat: 2,
      range: { inserting: r(0, 0, 0, 1), replacing: r(0, 0, 0, 2) },
      command: { command: "c", title: "T" },
    },
    { label: "plain", insertText: "p" },
  ])
  assert.equal(wire.wireCompletions(undefined), null)
})

test("locations, links and workspace edits use URI strings", () => {
  const uri = Uri.file("/a b.ts")
  assert.deepEqual(
    wire.wireLocations([
      new api.Location(uri, new Position(1, 2)),
      {
        targetUri: uri,
        targetRange: new Range(0, 0, 5, 0),
        targetSelectionRange: new Range(1, 0, 1, 3),
      },
    ]),
    [
      { uri: "file:///a%20b.ts", range: r(1, 2, 1, 2) },
      { uri: "file:///a%20b.ts", range: r(1, 0, 1, 3) },
    ]
  )
  const edit = new WorkspaceEdit()
  edit.replace(uri, new Range(0, 0, 0, 1), "z")
  edit.set(Uri.file("/c.ts"), [TextEdit.insert(new Position(0, 0), "y")])
  assert.deepEqual(wire.wireWorkspaceEdit(edit), {
    changes: {
      "file:///a%20b.ts": [{ range: r(0, 0, 0, 1), newText: "z" }],
      "file:///c.ts": [{ range: r(0, 0, 0, 0), newText: "y" }],
    },
  })
})

test("hover, symbols, folding, selection ranges, tokens and hints", () => {
  assert.deepEqual(
    wire.wireHover(new api.Hover([new MarkdownString("*a*"), { language: "ts", value: "x" }])),
    {
      contents: [
        { kind: "markdown", value: "*a*" },
        { language: "ts", value: "x" },
      ],
    }
  )
  const parent = new api.DocumentSymbol(
    "A",
    "",
    api.SymbolKind.Class,
    new Range(0, 0, 9, 0),
    new Range(0, 6, 0, 7)
  )
  parent.children = [
    new api.DocumentSymbol(
      "b",
      "d",
      api.SymbolKind.Method,
      new Range(1, 0, 2, 0),
      new Range(1, 2, 1, 3)
    ),
  ]
  const [symbol] = wire.wireDocumentSymbols([parent])
  assert.equal(symbol.kind, api.SymbolKind.Class, "symbol kinds stay VS Code's (Monaco's)")
  assert.equal(symbol.children[0].detail, "d")
  const [flat] = wire.wireDocumentSymbols([
    new api.SymbolInformation(
      "f",
      api.SymbolKind.Function,
      new Range(3, 0, 4, 0),
      Uri.file("/a.ts"),
      "M"
    ),
  ])
  assert.deepEqual(flat.range, r(3, 0, 4, 0))
  assert.equal(flat.detail, "M")
  assert.deepEqual(
    wire.wireFoldingRanges([
      new api.FoldingRange(1, 4, api.FoldingRangeKind.Imports),
      new api.FoldingRange(5, 6),
    ]),
    [
      { startLine: 1, endLine: 4, kind: "imports" },
      { startLine: 5, endLine: 6 },
    ]
  )
  assert.deepEqual(
    wire.wireSelectionRanges([
      new api.SelectionRange(new Range(0, 1, 0, 2), new api.SelectionRange(new Range(0, 0, 0, 9))),
    ]),
    [[{ range: r(0, 1, 0, 2) }, { range: r(0, 0, 0, 9) }]]
  )
  assert.deepEqual(wire.wireSemanticTokens({ data: Uint32Array.from([1, 2, 3]), resultId: "x" }), {
    resultId: "x",
    data: [1, 2, 3],
  })
  const hint = new api.InlayHint(
    new Position(0, 3),
    [new api.InlayHintLabelPart(": "), new api.InlayHintLabelPart("int")],
    api.InlayHintKind.Type
  )
  hint.paddingLeft = true
  assert.deepEqual(wire.wireInlayHints([hint]), {
    hints: [
      {
        position: { line: 0, character: 3 },
        label: [{ value: ": " }, { value: "int" }],
        kind: 1,
        paddingLeft: true,
      },
    ],
  })
  assert.deepEqual(
    wire.wireDocumentHighlights([
      new api.DocumentHighlight(new Range(0, 0, 0, 1), api.DocumentHighlightKind.Write),
    ]),
    [{ range: r(0, 0, 0, 1), kind: 3 }]
  )
  assert.deepEqual(
    wire.wireInlineCompletions(
      new api.InlineCompletionList([new api.InlineCompletionItem(new api.SnippetString("s$0"))])
    ),
    {
      items: [{ insertText: { snippet: "s$0" } }],
    }
  )
  assert.deepEqual(
    wire.wireLinkedEditingRanges(new api.LinkedEditingRanges([new Range(0, 0, 0, 1)], /\w+/)),
    {
      ranges: [r(0, 0, 0, 1)],
      wordPattern: "\\w+",
    }
  )
})

test("code actions keep kinds, disabled reasons and bare commands", () => {
  const action = new api.CodeAction("Extract", api.CodeActionKind.RefactorExtract)
  action.disabled = { reason: "nothing selected" }
  assert.deepEqual(
    wire.wireCodeActions([action, { title: "Run", command: "ext.run", arguments: [1] }]),
    [
      { title: "Extract", kind: "refactor.extract", disabled: "nothing selected" },
      { title: "Run", command: "ext.run", arguments: [1] },
    ]
  )
})

test("hierarchy items round-trip as the same object, and old ones are dropped", () => {
  const items = new wire.HierarchyItems()
  const item = new api.CallHierarchyItem(
    api.SymbolKind.Function,
    "f",
    "",
    Uri.file("/a.ts"),
    new Range(0, 0, 0, 1),
    new Range(0, 0, 0, 1)
  )
  const sent = items.wire(item)
  assert.equal(sent.uri, "file:///a.ts")
  assert.equal(items.revive(sent), item)
  for (let index = 0; index < wire.HIERARCHY_ITEM_LIMIT; index += 1) items.wire({ ...item })
  assert.equal(items.revive(sent), undefined)
  assert.equal(items.revive({}), undefined)
})

test("selectors: wire form and VS Code's match scores", () => {
  assert.deepEqual(
    wireSelector([
      "go",
      { language: "ts", scheme: "file", pattern: "**/*.ts" },
      { notebookType: "jupyter" },
    ]),
    ["go", { language: "ts", scheme: "file", pattern: "**/*.ts" }]
  )
  assert.deepEqual(wireSelector({ notebookType: "jupyter" }), ["*"])
  assert.deepEqual(wireSelector({ pattern: { baseUri: Uri.file("/repo"), pattern: "src/**" } }), [
    { pattern: { base: "/repo", pattern: "src/**" } },
  ])
  const document = new TextDocument("file:///repo/src/a.ts", "typescript", 1, "", async () => false)
  assert.equal(matchSelector("typescript", document), 10)
  assert.equal(matchSelector("*", document), 5)
  assert.equal(matchSelector(["go", { language: "typescript", scheme: "untitled" }], document), 0)
  assert.equal(matchSelector({ scheme: "file", pattern: "**/*.ts" }, document), 10)
  assert.equal(
    matchSelector({ pattern: "*.ts" }, document),
    10,
    "a bare file pattern matches anywhere"
  )
  assert.equal(matchSelector({ pattern: { base: "/repo", pattern: "lib/**" } }, document), 0)
  assert.ok(globToRegExp("src/{a,b}.ts").test("src/b.ts"))
  assert.ok(!globToRegExp("src/*.ts").test("src/x/y.ts"))
  assert.ok(globToRegExp("**/x?.ts").test("x1.ts"))
})

test("language configurations carry their RegExps across JSON", () => {
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        encodeRegExps({ wordPattern: /\w+/g, onEnterRules: [{ beforeText: /^\s*\/\/ / }] })
      )
    ),
    {
      wordPattern: { $regexp: "\\w+", flags: "g" },
      onEnterRules: [{ beforeText: { $regexp: "^\\s*\\/\\/ ", flags: "" } }],
    }
  )
})

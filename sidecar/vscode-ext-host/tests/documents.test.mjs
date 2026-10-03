import assert from "node:assert/strict"
import { test } from "node:test"

const { DocumentStore, TextDocument, VERSION_WAIT_MS } =
  await import("../dist/vscode-shim/documents.js")
const { CancellationTokenSource, Position, Range, Selection } =
  await import("../dist/vscode-shim/types.js")

const noSave = async () => false

test("a document maps offsets, lines and words like VS Code, CRLF included", () => {
  const document = new TextDocument(
    "file:///a%20b.txt",
    "plaintext",
    3,
    "ab\r\ncd ef\nlast",
    noSave
  )
  assert.equal(document.fileName, "/a b.txt")
  assert.equal(document.lineCount, 3)
  assert.equal(document.eol, 2)
  assert.equal(document.offsetAt(new Position(1, 1)), 5)
  assert.deepEqual(document.positionAt(5), new Position(1, 1))
  // An offset inside the CRLF pair belongs to the end of its line.
  assert.deepEqual(document.positionAt(3), new Position(0, 2))
  assert.deepEqual(document.positionAt(999), new Position(2, 4))
  assert.equal(document.getText(new Range(1, 0, 2, 2)), "cd ef\nla")
  const line = document.lineAt(1)
  assert.equal(line.text, "cd ef")
  assert.deepEqual(line.rangeIncludingLineBreak, new Range(1, 0, 2, 0))
  assert.equal(document.lineAt(2).isEmptyOrWhitespace, false)
  assert.throws(() => document.lineAt(3), RangeError)
  assert.deepEqual(document.getWordRangeAtPosition(new Position(1, 4)), new Range(1, 3, 1, 5))
  // Between two words the first one touching the position wins, as in VS Code.
  assert.deepEqual(
    document.getWordRangeAtPosition(new Position(1, 1), /[a-z]/),
    new Range(1, 0, 1, 1)
  )
  assert.equal(document.getWordRangeAtPosition(new Position(1, 2), /x/), undefined)
  assert.deepEqual(document.validatePosition(new Position(9, 9)), new Position(2, 4))
  assert.deepEqual(document.validateRange(new Range(0, 9, 0, 9)), new Range(0, 2, 0, 2))
})

test("an edit is reported as the one span that changed", () => {
  const document = new TextDocument("file:///a.txt", "plaintext", 1, "one two three", noSave)
  assert.deepEqual(document.replaceText("one 2 three", 2), {
    range: new Range(0, 4, 0, 7),
    rangeOffset: 4,
    rangeLength: 3,
    text: "2",
  })
  assert.equal(document.version, 2)
  assert.equal(document.replaceText("one 2 three", 3), null)
  assert.equal(document.version, 3)
})

test("the store fires open, change, language and close, and ignores stale edits", () => {
  const store = new DocumentStore(noSave)
  const events = []
  store.onDidOpen.event((document) => events.push(`open:${document.languageId}`))
  store.onDidChange.event((event) => events.push(`change:${event.document.version}`))
  store.onDidClose.event((document) => events.push(`close:${document.isClosed}`))
  store.open("file:///a.ts", "typescript", 1, "a")
  store.change("file:///a.ts", 3, "abc")
  store.change("file:///a.ts", 2, "stale")
  store.setLanguage("file:///a.ts", "javascript")
  store.setLanguage("file:///a.ts", "javascript")
  assert.equal(store.get("file:///a.ts").getText(), "abc")
  store.close("file:///a.ts")
  assert.deepEqual(events, [
    "open:typescript",
    "change:3",
    "close:false",
    "open:javascript",
    "close:true",
  ])
  assert.deepEqual(store.all(), [])
})

test("editors: active, visible and selection changes", () => {
  const store = new DocumentStore(noSave)
  store.open("file:///a.ts", "typescript", 1, "abc")
  const events = []
  store.onDidChangeActiveEditor.event((editor) => events.push(`active:${editor?.id ?? "none"}`))
  store.onDidChangeVisibleEditors.event((editors) => events.push(`visible:${editors.length}`))
  store.onDidChangeSelection.event((event) =>
    events.push(`selection:${event.selections[0].active.character}`)
  )
  const at = (character) => ({ anchor: { line: 0, character: 0 }, active: { line: 0, character } })
  store.setEditors([{ id: "e1", uri: "file:///a.ts", selections: [at(1)] }], "e1")
  store.setEditors([{ id: "e1", uri: "file:///a.ts", selections: [at(2)] }], "e1")
  // An editor on a document the host does not know is left out.
  store.setEditors(
    [
      { id: "e1", uri: "file:///a.ts", selections: [at(2)] },
      { id: "e2", uri: "file:///unknown.ts", selections: [at(0)] },
    ],
    "e2"
  )
  assert.deepEqual(events, ["visible:1", "active:e1", "selection:2", "active:none"])
  assert.equal(store.visibleEditors[0].selection.active.character, 2)
  assert.equal(store.visibleEditors[0].document, store.get("file:///a.ts"))
})

test("waiting for a version: resolves on the edit, gives up after the limit, never waits without one", async () => {
  const store = new DocumentStore(noSave)
  store.open("file:///a.ts", "typescript", 1, "a")
  const waiting = store.waitForVersion("file:///a.ts", 2)
  store.change("file:///a.ts", 2, "b")
  assert.equal((await waiting).getText(), "b")

  const opening = store.waitForVersion("file:///later.ts", 1)
  store.open("file:///later.ts", "typescript", 1, "x")
  assert.equal((await opening).getText(), "x")

  const started = Date.now()
  assert.equal(await store.waitForVersion("file:///never.ts", undefined), undefined)
  assert.ok(Date.now() - started < 50)

  const stale = await store.waitForVersion("file:///a.ts", 99)
  assert.ok(Date.now() - started >= VERSION_WAIT_MS - 10)
  assert.equal(stale.getText(), "b", "past the limit the newest text is used")
})

test("save goes to the renderer", async () => {
  const saved = []
  const store = new DocumentStore(async (document) => {
    saved.push(document.uri.toString())
    return true
  })
  assert.equal(await store.open("file:///a.ts", "typescript", 1, "a").save(), true)
  assert.deepEqual(saved, ["file:///a.ts"])
})

test("a cancellation listener added after cancelling still runs", async () => {
  const source = new CancellationTokenSource()
  source.cancel()
  const fired = await new Promise((resolve) => {
    source.token.onCancellationRequested(() => resolve(true))
    setTimeout(() => resolve(false), 100)
  })
  assert.equal(fired, true)
  assert.equal(source.token.isCancellationRequested, true)
})

function recordingOperations(answer = true) {
  const calls = []
  const outcome = answer ? { applied: true } : { applied: false }
  return {
    calls,
    operations: {
      edit: async (...args) => (calls.push(["edit", ...args]), outcome),
      insertSnippet: async (...args) => (calls.push(["snippet", ...args]), outcome),
      setDecorations: (...args) => calls.push(["decorations", ...args]),
      revealRange: (...args) => calls.push(["reveal", ...args]),
      setSelections: (...args) => calls.push(["selections", ...args]),
      setOptions: (...args) => calls.push(["options", ...args]),
    },
  }
}

const zero = { anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } }

test("editor.edit sends the batch against the current version and refuses overlaps", async () => {
  const { calls, operations } = recordingOperations()
  const store = new DocumentStore(noSave, operations)
  store.open("file:///a.ts", "typescript", 7, "hello\nworld")
  store.setEditors([{ id: "e", uri: "file:///a.ts", selections: [zero] }], "e")
  const editor = store.activeEditor

  assert.equal(
    await editor.edit(
      (builder) => {
        builder.insert(new Position(0, 0), ">")
        builder.replace(new Range(1, 0, 1, 5), "there")
        builder.delete(new Range(0, 9, 0, 99)) // clamped to the line's end
        builder.setEndOfLine(2)
      },
      { undoStopBefore: false }
    ),
    true
  )
  assert.deepEqual(calls[0], [
    "edit",
    "e",
    7,
    [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: ">" },
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
        text: "there",
      },
      { range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } }, text: "" },
    ],
    { undoStopBefore: false, undoStopAfter: true, endOfLine: 2 },
  ])

  await assert.rejects(
    editor.edit((builder) => {
      builder.replace(new Range(0, 0, 0, 3), "x")
      builder.replace(new Range(0, 2, 0, 4), "y")
    }),
    /Overlapping/
  )
  // Nothing to do answers true without a round trip.
  assert.equal(await editor.edit(() => {}), true)
  assert.equal(calls.length, 1)

  store.close("file:///a.ts")
  assert.equal(await editor.edit((builder) => builder.insert(new Position(0, 0), "x")), false)
})

test("snippets go to the given locations, or the selections", async () => {
  const { calls, operations } = recordingOperations(false)
  const store = new DocumentStore(noSave, operations)
  store.open("file:///a.ts", "typescript", 2, "abc")
  store.setEditors(
    [
      {
        id: "e",
        uri: "file:///a.ts",
        selections: [{ anchor: { line: 0, character: 1 }, active: { line: 0, character: 2 } }],
      },
    ],
    "e"
  )
  const editor = store.activeEditor
  assert.equal(await editor.insertSnippet({ value: "${1:x}" }), false)
  await editor.insertSnippet({ value: "$0" }, [new Position(0, 0), new Range(0, 2, 0, 3)])
  assert.deepEqual(calls[0].slice(0, 5), [
    "snippet",
    "e",
    2,
    "${1:x}",
    [{ start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }],
  ])
  assert.deepEqual(calls[1][4], [
    { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } },
  ])
})

test("decorations, reveal, selections and options reach the renderer; reports do not echo", () => {
  const { calls, operations } = recordingOperations()
  const store = new DocumentStore(noSave, operations)
  store.open("file:///a.ts", "typescript", 1, "a\nb\nc")
  store.setEditors([{ id: "e", uri: "file:///a.ts", selections: [zero] }], "e")
  const editor = store.activeEditor
  const events = []
  store.onDidChangeVisibleRanges.event((event) =>
    events.push(`ranges:${event.visibleRanges[0].end.line}`)
  )
  store.onDidChangeOptions.event((event) => events.push(`tab:${event.options.tabSize}`))

  assert.deepEqual(
    editor.visibleRanges,
    [new Range(0, 0, 2, 0)],
    "the whole document until reported"
  )
  assert.equal(editor.options.tabSize, 4)

  editor.setDecorations({ key: "deco:x:1" }, [
    new Range(0, 0, 0, 1),
    {
      range: new Range(1, 0, 1, 1),
      hoverMessage: [{ value: "**a**" }, "b"],
      renderOptions: { after: { contentText: "!" } },
    },
  ])
  editor.revealRange(new Range(2, 0, 2, 0), 1)
  editor.selection = new Selection(new Position(1, 0), new Position(1, 1))
  editor.options.tabSize = 2
  editor.options = { insertSpaces: false }
  assert.deepEqual(calls, [
    [
      "decorations",
      "e",
      "deco:x:1",
      [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
          hoverMessage: "**a**\n\nb",
          renderOptions: { after: { contentText: "!" } },
        },
      ],
    ],
    ["reveal", "e", { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } }, 1],
    ["selections", "e", [{ anchor: { line: 1, character: 0 }, active: { line: 1, character: 1 } }]],
    ["options", "e", { tabSize: 2 }],
    ["options", "e", { insertSpaces: false }],
  ])
  assert.equal(editor.options.tabSize, 2)

  // The renderer's report updates the editor and fires events, without calling back.
  store.setEditors(
    [
      {
        id: "e",
        uri: "file:///a.ts",
        selections: [zero],
        visibleRanges: [{ start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }],
        options: { tabSize: 8 },
      },
    ],
    "e"
  )
  assert.equal(calls.length, 5)
  assert.deepEqual(events, ["ranges:1", "tab:8"])
  assert.equal(editor.selection.active.line, 0)
})

test("an applied edit resolves once the document shows it", async () => {
  const store = new DocumentStore(noSave, {
    ...recordingOperations().operations,
    edit: async () => {
      setTimeout(() => store.change("file:///a.ts", 8, ">a"), 20)
      return { applied: true, version: 8 }
    },
  })
  store.open("file:///a.ts", "typescript", 7, "a")
  store.setEditors([{ id: "e", uri: "file:///a.ts", selections: [zero] }], "e")
  const editor = store.activeEditor
  assert.equal(await editor.edit((builder) => builder.insert(new Position(0, 0), ">")), true)
  assert.equal(editor.document.getText(), ">a")
})

test("an editor opening a detached document takes it over, version and all", () => {
  const store = new DocumentStore(noSave)
  const events = []
  store.onDidChange.event((event) => events.push(`change:${event.document.version}`))
  store.onDidClose.event(() => events.push("close"))
  store.onDidOpen.event((document) => events.push(`open:${document.languageId}`))
  const detached = store.open("file:///a.ts", "plaintext", 5, "disk")
  // The editor's numbering restarts at 1 and may be behind the detached copy's.
  assert.equal(store.open("file:///a.ts", "typescript", 1, "editor"), detached)
  assert.equal(detached.version, 1)
  assert.equal(detached.getText(), "editor")
  assert.deepEqual(events, ["open:plaintext", "close", "open:typescript", "change:1"])
})

test("waiting for an editor: the focused one on the document, or none after the limit", async () => {
  const store = new DocumentStore(noSave)
  store.open("file:///a.ts", "typescript", 1, "a")
  const waiting = store.waitForEditor("file:///a.ts")
  setTimeout(
    () => store.setEditors([{ id: "e", uri: "file:///a.ts", selections: [zero] }], "e"),
    10
  )
  assert.equal((await waiting).id, "e")
  assert.equal((await store.waitForEditor("file:///a.ts")).id, "e")
})

test("a workspace edit keeps its steps in the order they were added", async () => {
  const { WorkspaceEdit, Uri, TextEdit } = await import("../dist/vscode-shim/types.js")
  const edit = new WorkspaceEdit()
  const a = Uri.file("/a.ts")
  const b = Uri.file("/b.ts")
  edit.createFile(b, { contents: new Uint8Array([0xff]) })
  edit.insert(b, new Position(0, 0), "1")
  edit.insert(b, new Position(0, 1), "2")
  edit.replace(a, new Range(0, 0, 0, 1), "x")
  edit.renameFile(b, Uri.file("/c.ts"), { overwrite: true })
  edit.set(a, [TextEdit.setEndOfLine(2), TextEdit.delete(new Range(0, 0, 0, 2))])
  edit.deleteFile(Uri.file("/d"), { recursive: true })
  const range = (sl, sc, el, ec) => new Range(sl, sc, el, ec)
  assert.deepEqual(JSON.parse(JSON.stringify(edit)), {
    operations: [
      { kind: "create", uri: "file:///b.ts", options: {}, contents: { binary: true } },
      {
        kind: "edit",
        uri: "file:///b.ts",
        edits: [
          { range: JSON.parse(JSON.stringify(range(0, 0, 0, 0))), newText: "1" },
          { range: JSON.parse(JSON.stringify(range(0, 1, 0, 1))), newText: "2" },
        ],
      },
      {
        kind: "rename",
        oldUri: "file:///b.ts",
        newUri: "file:///c.ts",
        options: { overwrite: true },
      },
      // `set` replaced the document's earlier edits, so they move to where it was called.
      {
        kind: "edit",
        uri: "file:///a.ts",
        edits: [{ range: JSON.parse(JSON.stringify(range(0, 0, 0, 2))), newText: "" }],
        eol: 2,
      },
      { kind: "delete", uri: "file:///d", options: { recursive: true } },
    ],
  })
  assert.equal(edit.size, 5)
  assert.deepEqual(
    edit.get(b).map((e) => e.newText),
    ["1", "2"]
  )
  assert.equal(edit.has(a), true)
  assert.equal(edit.fileOperations.length, 3)
  edit.delete(a)
  assert.equal(edit.has(a), false)
})

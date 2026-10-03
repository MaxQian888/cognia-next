import assert from "node:assert/strict"
import { test } from "node:test"

const { DocumentStore, TextDocument, VERSION_WAIT_MS } =
  await import("../dist/vscode-shim/documents.js")
const { CancellationTokenSource, Position, Range } = await import("../dist/vscode-shim/types.js")

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

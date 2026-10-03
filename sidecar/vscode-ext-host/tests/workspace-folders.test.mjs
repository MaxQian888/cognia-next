import assert from "node:assert/strict"
import { test } from "node:test"

const { WorkspaceFolders } = await import("../dist/vscode-shim/workspace-folders.js")
const { Uri } = await import("../dist/vscode-shim/types.js")

test("folders keep their objects across reports and fire only real changes", () => {
  const folders = new WorkspaceFolders()
  const events = []
  folders.onDidChange.event((event) =>
    events.push([event.added.map((f) => f.name), event.removed.map((f) => f.name)])
  )
  assert.equal(folders.folders, undefined)
  folders.set([{ uri: "file:///a", name: "a" }])
  const first = folders.folders[0]
  folders.set([{ uri: "file:///a", name: "a" }])
  assert.equal(folders.folders[0], first)
  folders.set([
    { uri: "file:///b", name: "b" },
    { uri: "file:///a", name: "a" },
  ])
  assert.notEqual(folders.folders[1], first, "a moved, so it is a new object with its new index")
  assert.equal(folders.folders[1].index, 1)
  assert.deepEqual(events, [
    [["a"], []],
    [["b"], []],
  ])
})

test("the innermost folder holds a URI; relative paths name the folder when several are open", () => {
  const folders = new WorkspaceFolders()
  folders.set([
    { uri: "file:///repo", name: "repo" },
    { uri: "file:///repo/packages/inner", name: "inner" },
  ])
  assert.equal(folders.getWorkspaceFolder(Uri.file("/repo/packages/inner/x.ts")).name, "inner")
  assert.equal(folders.getWorkspaceFolder(Uri.file("/repo2/x.ts")), undefined)
  assert.equal(folders.getWorkspaceFolder(Uri.parse("git:/repo/x.ts")), undefined)
  assert.equal(folders.asRelativePath("/repo/src/a.ts"), "repo/src/a.ts")
  assert.equal(folders.asRelativePath("/repo/src/a.ts", false), "src/a.ts")
  assert.equal(folders.asRelativePath(Uri.file("/elsewhere/a.ts")), "/elsewhere/a.ts")
  assert.equal(folders.asRelativePath("/repo"), "repo")
})

test("watcher events reach the watcher that owns the handle, until it is removed", () => {
  const folders = new WorkspaceFolders()
  const seen = []
  const remove = folders.addWatcher("w", (kind, uri) => seen.push(`${kind} ${uri.path}`))
  const handlers = new Map()
  folders.attach({ onRequest: (method, handler) => handlers.set(method, handler) })
  handlers.get("workspace:fileSystemEvents")({
    handle: "w",
    events: [{ kind: "change", uri: "file:///a" }],
  })
  handlers.get("workspace:fileSystemEvents")({
    handle: "other",
    events: [{ kind: "change", uri: "file:///b" }],
  })
  remove()
  handlers.get("workspace:fileSystemEvents")({
    handle: "w",
    events: [{ kind: "delete", uri: "file:///a" }],
  })
  assert.deepEqual(seen, ["change /a"])
  handlers.get("workspace:foldersChanged")({ folders: [{ uri: "file:///x", name: "x" }] })
  assert.equal(folders.folders[0].name, "x")
})

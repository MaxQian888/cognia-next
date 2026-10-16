import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  createPreMutationReporter,
  mutationTargets,
  snapshotTargets,
  type PreMutationFrame,
} from "./file-checkpoint.ts"

function scratch(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "file-checkpoint-")))
}

test("mutationTargets names every path a built-in file writer changes", () => {
  const cwd = "/w"
  const paths = (name: string, input: unknown) =>
    mutationTargets(name, input, cwd)?.map((t) => t.path)
  assert.deepEqual(paths("mcp__cognia-tools__write", { file_path: "a.txt" }), ["/w/a.txt"])
  assert.deepEqual(paths("edit", { file_path: "/abs/b.ts" }), ["/abs/b.ts"])
  assert.deepEqual(paths("multi_edit", { file_path: "c" }), ["/w/c"])
  assert.deepEqual(paths("NotebookEdit", { file_path: "n.ipynb" }), ["/w/n.ipynb"])
  assert.deepEqual(paths("file_append", { path: "/w/log" }), ["/w/log"])
  assert.deepEqual(paths("file_binary_write", { path: "/w/img.png" }), ["/w/img.png"])
  assert.deepEqual(paths("file_copy", { source: "/w/a", destination: "/w/b" }), ["/w/b"])
  assert.deepEqual(paths("file_move", { source: "/w/a", destination: "/w/b" }), ["/w/a", "/w/b"])
  assert.deepEqual(paths("file_rename", { oldPath: "/w/a", newPath: "/w/b" }), ["/w/a", "/w/b"])
  assert.deepEqual(paths("directory_create", { path: "/w/d" }), ["/w/d"])
  assert.deepEqual(mutationTargets("directory_delete", { path: "/w/d", recursive: true }, cwd), [
    { path: "/w/d", recursive: true },
  ])
  assert.equal(mutationTargets("read", { file_path: "a" }, cwd), null)
  assert.equal(mutationTargets("bash", { command: "rm -rf x" }, cwd), null)
})

test("mutationTargets reads apply_patch headers, including creations, deletions and renames", () => {
  const patch = [
    "--- a/src/old.ts",
    "+++ b/src/new.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "--- /dev/null",
    "+++ b/created.txt",
    "@@ -0,0 +1 @@",
    "+hi",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "",
  ].join("\n")
  assert.deepEqual(
    mutationTargets("apply_patch", { patch }, "/w")?.map((t) => t.path),
    ["/w/src/old.ts", "/w/src/new.ts", "/w/created.txt", "/w/gone.txt"]
  )
  assert.deepEqual(mutationTargets("apply_patch", { patch: 42 }, "/w"), [])
})

test("mutationTargets keeps sandboxed editors to the shared workspace and skips view", () => {
  assert.deepEqual(
    mutationTargets("mcp__cognia-plugin-tools__sandbox_write", { path: "/w/x" }, "/w"),
    [{ path: "/w/x", workspaceOnly: true }]
  )
  assert.deepEqual(mutationTargets("sandbox_edit", { path: "/w/x" }, "/w"), [
    { path: "/w/x", workspaceOnly: true },
  ])
  assert.equal(
    mutationTargets("sandbox_text_editor", { command: "view", path: "/w/x" }, "/w"),
    null
  )
  assert.deepEqual(
    mutationTargets("sandbox_text_editor", { command: "create", path: "/w/x" }, "/w"),
    [{ path: "/w/x", workspaceOnly: true }]
  )
})

test("snapshotTargets captures bytes exactly, absent paths, and directories", () => {
  const dir = scratch()
  try {
    const binary = Buffer.from([0, 255, 10, 13, 128])
    fs.writeFileSync(path.join(dir, "bin"), binary)
    fs.mkdirSync(path.join(dir, "sub"))
    const entries = snapshotTargets([
      { path: path.join(dir, "bin") },
      { path: path.join(dir, "missing.txt") },
      { path: path.join(dir, "sub") },
      { path: path.join(dir, "bin") }, // duplicate target, captured once
    ])
    assert.equal(entries.length, 3)
    assert.equal(entries[0]!.before, "file")
    assert.deepEqual(Buffer.from(entries[0]!.contentBase64!, "base64"), binary)
    assert.deepEqual(entries[1], { path: path.join(dir, "missing.txt"), before: "absent" })
    assert.deepEqual(entries[2], { path: path.join(dir, "sub"), before: "directory" })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("snapshotTargets walks a recursive delete and refuses a partial tree", () => {
  const dir = scratch()
  try {
    const root = path.join(dir, "tree")
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true })
    fs.writeFileSync(path.join(root, "a", "one.txt"), "1")
    fs.writeFileSync(path.join(root, "a", "b", "two.txt"), "2")
    const full = snapshotTargets([{ path: root, recursive: true }])
    assert.deepEqual(full.map((e) => [path.relative(dir, e.path), e.before]).sort(), [
      ["tree", "directory"],
      ["tree/a", "directory"],
      ["tree/a/b", "directory"],
      ["tree/a/b/two.txt", "file"],
      ["tree/a/one.txt", "file"],
    ])
    const capped = snapshotTargets([{ path: root, recursive: true }], { treeEntryLimit: 2 })
    assert.deepEqual(capped, [{ path: root, before: "directory", omitted: "too-large" }])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("snapshotTargets reports oversized files and paths outside the workspace", () => {
  const dir = scratch()
  try {
    fs.writeFileSync(path.join(dir, "big"), "0123456789")
    const entries = snapshotTargets(
      [
        { path: path.join(dir, "big") },
        { path: "/somewhere/else", workspaceOnly: true },
        { path: path.join(dir, "big2"), workspaceOnly: true },
      ],
      { fileLimitBytes: 4, workspaceRoots: [dir] }
    )
    assert.deepEqual(entries, [
      { path: path.join(dir, "big"), before: "file", omitted: "too-large" },
      { path: "/somewhere/else", before: "absent", omitted: "outside-workspace" },
      { path: path.join(dir, "big2"), before: "absent" },
    ])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("createPreMutationReporter emits one frame for a writer and nothing for a reader", () => {
  const dir = scratch()
  try {
    fs.writeFileSync(path.join(dir, "keep.txt"), "original")
    const frames: PreMutationFrame[] = []
    const report = createPreMutationReporter({
      emit: (frame) => frames.push(frame),
      sessionId: "s1",
      cwd: dir,
      workspaceRoots: [dir],
    })
    report("mcp__cognia-tools__read", { file_path: "keep.txt" })
    report("mcp__cognia-tools__write", { file_path: "keep.txt", content: "new" })
    assert.equal(frames.length, 1)
    assert.equal(frames[0]!.type, "file_pre_mutation")
    assert.equal(frames[0]!.sessionId, "s1")
    assert.equal(
      Buffer.from(frames[0]!.entries[0]!.contentBase64!, "base64").toString(),
      "original"
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

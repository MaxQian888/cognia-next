import test from "node:test"
import assert from "node:assert/strict"

import { createMemoryStore, splitIdentifier } from "./store-memory.mjs"

function node(over = {}) {
  return {
    id: over.id ?? "f.ts::foo::1",
    kind: over.kind ?? "function",
    name: over.name ?? "foo",
    qualified_name: over.qualified_name ?? "foo",
    file_path: over.file_path ?? "f.ts",
    language: over.language ?? "typescript",
    start_line: over.start_line ?? 1,
    start_col: 0,
    end_line: over.end_line ?? 5,
    end_col: 0,
    docstring: over.docstring ?? null,
    signature: over.signature ?? "function foo()",
    visibility: over.visibility ?? null,
    is_exported: over.is_exported ?? 0,
    is_async: 0,
    is_static: 0,
    return_type: null,
    updated_at: 0,
    ...over,
  }
}

function fileRec(path, over = {}) {
  return {
    path,
    content_hash: over.content_hash ?? "h",
    language: over.language ?? "typescript",
    size: 10,
    modified_at: 1,
    indexed_at: 1,
    node_count: over.node_count ?? 1,
    errors: null,
  }
}

test("splitIdentifier breaks camelCase and snake_case", () => {
  const toks = splitIdentifier("getUserName_v2")
  assert.ok(toks.includes("getUserName_v2") || toks.includes("getUserName"))
  assert.ok(toks.includes("get"))
  assert.ok(toks.includes("User"))
  assert.ok(toks.includes("Name"))
})

test("upsertFile / getFile / allFiles / deleteFile", () => {
  const s = createMemoryStore()
  s.upsertFile(fileRec("a.ts"))
  assert.equal(s.getFile("a.ts").path, "a.ts")
  assert.equal(s.allFiles().length, 1)
  s.deleteFile("a.ts")
  assert.equal(s.getFile("a.ts"), null)
})

test("replaceFileGraph inserts and is idempotent per file", () => {
  const s = createMemoryStore()
  s.replaceFileGraph("a.ts", {
    nodes: [node({ id: "a.ts::foo::1", name: "foo", file_path: "a.ts" })],
    edges: [{ source: "a.ts::foo::1", target: "a.ts::bar::9", kind: "calls", provenance: "ts" }],
    unresolved: [
      {
        from_node_id: "a.ts::foo::1",
        reference_name: "bar",
        reference_kind: "calls",
        file_path: "a.ts",
        language: "typescript",
      },
    ],
    file: fileRec("a.ts"),
  })
  assert.equal(s.stats().nodeCount, 1)
  assert.equal(s.stats().edgeCount, 1)
  assert.equal(s.stats().unresolvedCount, 1)

  // Re-extract the same file → old graph replaced, not duplicated.
  s.replaceFileGraph("a.ts", {
    nodes: [node({ id: "a.ts::foo::1", name: "foo", file_path: "a.ts" })],
    edges: [],
    unresolved: [],
    file: fileRec("a.ts"),
  })
  assert.equal(s.stats().nodeCount, 1)
  assert.equal(s.stats().edgeCount, 0)
  assert.equal(s.stats().unresolvedCount, 0)
})

test("getNode by id and by qualified_name; nodesByName", () => {
  const s = createMemoryStore()
  s.insertNodes([node({ id: "id1", name: "foo", qualified_name: "ns.foo" })])
  assert.equal(s.getNode("id1").name, "foo")
  assert.equal(s.getNode("ns.foo").id, "id1")
  assert.equal(s.getNode("missing"), null)
  assert.equal(s.nodesByName("foo").length, 1)
  assert.equal(s.nodesByName("ns.foo").length, 1)
})

test("searchNodes ranks exact name match highest and honours kind+limit", () => {
  const s = createMemoryStore()
  s.insertNodes([
    node({ id: "1", name: "parseConfig", qualified_name: "parseConfig", kind: "function" }),
    node({ id: "2", name: "parse", qualified_name: "parse", kind: "function" }),
    node({ id: "3", name: "ConfigParser", qualified_name: "ConfigParser", kind: "class" }),
  ])
  const hits = s.searchNodes("parse", { limit: 2 })
  assert.equal(hits[0].name, "parse") // exact match wins
  assert.ok(hits.length <= 2)
  const onlyClass = s.searchNodes("config", { kind: "class" })
  assert.ok(onlyClass.every((n) => n.kind === "class"))
})

test("searchNodes returns [] for empty query", () => {
  const s = createMemoryStore()
  s.insertNodes([node()])
  assert.deepEqual(s.searchNodes(""), [])
  assert.deepEqual(s.searchNodes(null), [])
})

test("edgesFrom / edgesTo filter by kind", () => {
  const s = createMemoryStore()
  s.insertEdges([
    { source: "a", target: "b", kind: "calls", provenance: "x" },
    { source: "a", target: "c", kind: "imports", provenance: "x" },
  ])
  assert.equal(s.edgesFrom("a").length, 2)
  assert.equal(s.edgesFrom("a", "calls").length, 1)
  assert.equal(s.edgesTo("b").length, 1)
  assert.equal(s.edgesTo("b", "imports").length, 0)
})

test("unresolvedAll / deleteUnresolved by id", () => {
  const s = createMemoryStore()
  s.insertUnresolved([
    {
      from_node_id: "a",
      reference_name: "x",
      reference_kind: "calls",
      file_path: "a.ts",
      language: "ts",
    },
    {
      from_node_id: "a",
      reference_name: "y",
      reference_kind: "calls",
      file_path: "a.ts",
      language: "ts",
    },
  ])
  const all = s.unresolvedAll()
  assert.equal(all.length, 2)
  assert.ok(all.every((u) => typeof u.id === "number"))
  s.deleteUnresolved([all[0].id])
  assert.equal(s.unresolvedAll().length, 1)
})

test("deleteFile drops the file's nodes, edges and unresolved", () => {
  const s = createMemoryStore()
  s.replaceFileGraph("a.ts", {
    nodes: [node({ id: "a.ts::foo::1", file_path: "a.ts" })],
    edges: [{ source: "a.ts::foo::1", target: "x", kind: "calls", provenance: "ts" }],
    unresolved: [
      {
        from_node_id: "a.ts::foo::1",
        reference_name: "x",
        reference_kind: "calls",
        file_path: "a.ts",
        language: "ts",
      },
    ],
    file: fileRec("a.ts"),
  })
  s.deleteFile("a.ts")
  const st = s.stats()
  assert.equal(st.nodeCount, 0)
  assert.equal(st.edgeCount, 0)
  assert.equal(st.unresolvedCount, 0)
})

test("stats aggregates language histogram; close clears", () => {
  const s = createMemoryStore()
  s.upsertFile(fileRec("a.ts", { language: "typescript" }))
  s.upsertFile(fileRec("b.rs", { language: "rust" }))
  const st = s.stats()
  assert.equal(st.languages.typescript, 1)
  assert.equal(st.languages.rust, 1)
  assert.equal(st.binding, "memory")
  s.close()
  assert.equal(s.stats().fileCount, 0)
})

import test from "node:test"
import assert from "node:assert/strict"

import { createMemoryStore } from "./store-memory.mjs"
import { resolveAll, resolveImportTarget } from "./resolver-pass.mjs"

function n(over) {
  return {
    id: over.id,
    kind: over.kind ?? "function",
    name: over.name,
    qualified_name: over.qualified_name ?? over.name,
    file_path: over.file_path,
    language: "typescript",
    start_line: over.start_line ?? 1,
    start_col: 0,
    end_line: 2,
    end_col: 0,
    docstring: null,
    signature: over.name,
    visibility: null,
    is_exported: over.is_exported ?? 0,
    is_async: 0,
    is_static: 0,
    return_type: null,
    updated_at: 0,
  }
}

test("resolveAll is a no-op on an empty store", () => {
  const s = createMemoryStore()
  assert.deepEqual(resolveAll(s), { resolved: 0, edgesAdded: 0, remaining: 0 })
})

test("resolves a cross-file call by name and deletes the ref", () => {
  const s = createMemoryStore()
  s.insertNodes([
    n({ id: "caller.ts::useFmt::1", name: "useFmt", file_path: "caller.ts" }),
    n({ id: "fmt.ts::format::1", name: "format", file_path: "fmt.ts", is_exported: 1 }),
  ])
  s.upsertFile({
    path: "caller.ts",
    content_hash: "h",
    language: "typescript",
    size: 1,
    modified_at: 1,
    indexed_at: 1,
    node_count: 1,
    errors: null,
  })
  s.upsertFile({
    path: "fmt.ts",
    content_hash: "h",
    language: "typescript",
    size: 1,
    modified_at: 1,
    indexed_at: 1,
    node_count: 1,
    errors: null,
  })
  s.insertUnresolved([
    {
      from_node_id: "caller.ts::useFmt::1",
      reference_name: "format",
      reference_kind: "calls",
      file_path: "caller.ts",
      language: "typescript",
    },
  ])
  const res = resolveAll(s)
  assert.equal(res.resolved, 1)
  assert.equal(res.remaining, 0)
  const edge = s.edgesFrom("caller.ts::useFmt::1", "calls")[0]
  assert.equal(edge.target, "fmt.ts::format::1")
  assert.equal(edge.provenance, "resolved")
  assert.equal(s.unresolvedAll().length, 0)
})

test("unknown reference stays unresolved for a later pass", () => {
  const s = createMemoryStore()
  s.insertNodes([n({ id: "a.ts::x::1", name: "x", file_path: "a.ts" })])
  s.insertUnresolved([
    {
      from_node_id: "a.ts::x::1",
      reference_name: "thirdPartyThing",
      reference_kind: "calls",
      file_path: "a.ts",
      language: "typescript",
    },
  ])
  const res = resolveAll(s)
  assert.equal(res.resolved, 0)
  assert.equal(res.remaining, 1)
  assert.equal(s.unresolvedAll().length, 1)
})

test("ambiguous targets pick a best candidate and record the alternatives", () => {
  const s = createMemoryStore()
  s.insertNodes([
    n({ id: "caller.ts::c::1", name: "c", file_path: "caller.ts" }),
    n({ id: "a.ts::run::1", name: "run", file_path: "a.ts", is_exported: 0 }),
    n({ id: "caller.ts::run::5", name: "run", file_path: "caller.ts", start_line: 5 }), // same-file → preferred
  ])
  s.insertUnresolved([
    {
      from_node_id: "caller.ts::c::1",
      reference_name: "run",
      reference_kind: "calls",
      file_path: "caller.ts",
      language: "typescript",
    },
  ])
  resolveAll(s)
  const edge = s.edgesFrom("caller.ts::c::1", "calls")[0]
  assert.equal(edge.target, "caller.ts::run::5") // same file wins
  assert.equal(edge.provenance, "resolved-ambiguous")
  assert.match(edge.metadata, /a\.ts::run::1/)
})

test("self-referential calls are not linked", () => {
  const s = createMemoryStore()
  s.insertNodes([n({ id: "a.ts::recur::1", name: "recur", file_path: "a.ts" })])
  s.insertUnresolved([
    {
      from_node_id: "a.ts::recur::1",
      reference_name: "recur",
      reference_kind: "calls",
      file_path: "a.ts",
      language: "typescript",
    },
  ])
  const res = resolveAll(s)
  assert.equal(res.resolved, 0)
})

test("resolves an inheritance ref to a class node", () => {
  const s = createMemoryStore()
  s.insertNodes([
    n({ id: "a.ts::Child::1", name: "Child", kind: "class", file_path: "a.ts" }),
    n({
      id: "base.ts::Base::1",
      name: "Base",
      kind: "class",
      file_path: "base.ts",
      is_exported: 1,
    }),
  ])
  s.insertUnresolved([
    {
      from_node_id: "a.ts::Child::1",
      reference_name: "Base",
      reference_kind: "extends",
      file_path: "a.ts",
      language: "typescript",
    },
  ])
  resolveAll(s)
  const edge = s.edgesFrom("a.ts::Child::1", "extends")[0]
  assert.equal(edge.target, "base.ts::Base::1")
})

test("resolveImportTarget: JS relative specifier with extension + index probing", () => {
  const files = new Set(["src/fmt.ts", "src/util/index.ts"])
  assert.equal(
    resolveImportTarget({ reference_name: "./fmt", file_path: "src/app.ts" }, files),
    "src/fmt.ts"
  )
  assert.equal(
    resolveImportTarget({ reference_name: "./util", file_path: "src/app.ts" }, files),
    "src/util/index.ts"
  )
  assert.equal(
    resolveImportTarget({ reference_name: "./missing", file_path: "src/app.ts" }, files),
    null
  )
})

test("resolveImportTarget: python dotted + rust crate path suffix match", () => {
  const py = new Set(["pkg/a/b.py"])
  assert.equal(
    resolveImportTarget({ reference_name: "a.b", file_path: "pkg/main.py" }, py),
    "pkg/a/b.py"
  )
  const rs = new Set(["src/foo/mod.rs"])
  assert.equal(
    resolveImportTarget({ reference_name: "crate::foo", file_path: "src/lib.rs" }, rs),
    "src/foo/mod.rs"
  )
})

test("resolveAll links a resolvable import edge between file nodes", () => {
  const s = createMemoryStore()
  s.insertNodes([
    {
      id: "app.ts",
      kind: "file",
      name: "app.ts",
      qualified_name: "app.ts",
      file_path: "app.ts",
      language: "typescript",
      start_line: 1,
      start_col: 0,
      end_line: 1,
      end_col: 0,
      docstring: null,
      signature: null,
      visibility: null,
      is_exported: 0,
      is_async: 0,
      is_static: 0,
      return_type: null,
      updated_at: 0,
    },
    {
      id: "fmt.ts",
      kind: "file",
      name: "fmt.ts",
      qualified_name: "fmt.ts",
      file_path: "fmt.ts",
      language: "typescript",
      start_line: 1,
      start_col: 0,
      end_line: 1,
      end_col: 0,
      docstring: null,
      signature: null,
      visibility: null,
      is_exported: 0,
      is_async: 0,
      is_static: 0,
      return_type: null,
      updated_at: 0,
    },
  ])
  s.upsertFile({
    path: "app.ts",
    content_hash: "h",
    language: "typescript",
    size: 1,
    modified_at: 1,
    indexed_at: 1,
    node_count: 0,
    errors: null,
  })
  s.upsertFile({
    path: "fmt.ts",
    content_hash: "h",
    language: "typescript",
    size: 1,
    modified_at: 1,
    indexed_at: 1,
    node_count: 0,
    errors: null,
  })
  s.insertUnresolved([
    {
      from_node_id: "app.ts",
      reference_name: "./fmt",
      reference_kind: "imports",
      file_path: "app.ts",
      language: "typescript",
    },
  ])
  resolveAll(s)
  const edge = s.edgesFrom("app.ts", "imports")[0]
  assert.equal(edge.target, "fmt.ts")
})

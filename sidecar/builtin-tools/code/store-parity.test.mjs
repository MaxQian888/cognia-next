// Parity suite: the same assertions run against both store backends. The
// sqlite arm skips when better-sqlite3 is unavailable (mirrors node-pty gating).

import test from "node:test"
import assert from "node:assert/strict"

import { createMemoryStore } from "./store-memory.mjs"
import { createStore, loadSqliteBinding } from "./store.mjs"
import { createSqliteStore, toFtsQuery } from "./store-sqlite.mjs"

const Database = loadSqliteBinding()

test("Bun runtimes prefer the built-in SQLite binding over better-sqlite3", () => {
  const calls = []
  class BunDatabase {}
  const binding = loadSqliteBinding({
    bunRuntime: true,
    requireModule(specifier) {
      calls.push(specifier)
      if (specifier === "bun:sqlite") return { Database: BunDatabase }
      throw new Error(`unexpected module: ${specifier}`)
    },
  })
  assert.ok(new binding(":memory:") instanceof BunDatabase)
  assert.deepEqual(calls, ["bun:sqlite"])
})

function node(over = {}) {
  return {
    id: over.id ?? "a.ts::foo::1",
    kind: over.kind ?? "function",
    name: over.name ?? "foo",
    qualified_name: over.qualified_name ?? over.name ?? "foo",
    file_path: over.file_path ?? "a.ts",
    language: over.language ?? "typescript",
    start_line: over.start_line ?? 1,
    start_col: 0,
    end_line: 5,
    end_col: 0,
    docstring: over.docstring ?? null,
    signature: over.signature ?? "function foo()",
    visibility: null,
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
    content_hash: "h",
    language: over.language ?? "typescript",
    size: 1,
    modified_at: 1,
    indexed_at: 1,
    node_count: over.node_count ?? 1,
    errors: null,
  }
}

/** Run a behavioral contract against a freshly-built store. */
function contract(makeStore) {
  return () => {
    const s = makeStore()
    try {
      s.replaceFileGraph("a.ts", {
        nodes: [
          node({ id: "a.ts::parseConfig::1", name: "parseConfig", qualified_name: "parseConfig" }),
          node({
            id: "a.ts::Helper::9",
            name: "Helper",
            qualified_name: "Helper",
            kind: "class",
            start_line: 9,
          }),
        ],
        edges: [
          {
            source: "a.ts::parseConfig::1",
            target: "a.ts::Helper::9",
            kind: "calls",
            provenance: "resolved",
          },
        ],
        unresolved: [
          {
            from_node_id: "a.ts::parseConfig::1",
            reference_name: "missing",
            reference_kind: "calls",
            file_path: "a.ts",
            language: "typescript",
          },
        ],
        file: fileRec("a.ts", { node_count: 2 }),
      })

      // stats
      const st = s.stats()
      assert.equal(st.fileCount, 1)
      assert.equal(st.nodeCount, 2)
      assert.equal(st.edgeCount, 1)
      assert.equal(st.unresolvedCount, 1)
      assert.equal(st.languages.typescript, 1)

      // getNode by id + qname
      assert.equal(s.getNode("a.ts::parseConfig::1").name, "parseConfig")
      assert.equal(s.getNode("Helper").kind, "class")
      assert.equal(s.getNode("nope"), null)

      // nodesByName
      assert.equal(s.nodesByName("parseConfig").length, 1)

      // search ranks exact-ish first, excludes the file node
      const hits = s.searchNodes("parse", { limit: 5 })
      assert.ok(hits.length >= 1)
      assert.equal(hits[0].name, "parseConfig")
      assert.ok(hits.every((h) => h.kind !== "file"))
      assert.equal(s.searchNodes("", {}).length, 0)
      const onlyClass = s.searchNodes("Helper", { kind: "class" })
      assert.ok(onlyClass.every((h) => h.kind === "class"))

      // edges
      assert.equal(s.edgesFrom("a.ts::parseConfig::1").length, 1)
      assert.equal(s.edgesFrom("a.ts::parseConfig::1", "calls").length, 1)
      assert.equal(s.edgesFrom("a.ts::parseConfig::1", "imports").length, 0)
      assert.equal(s.edgesTo("a.ts::Helper::9").length, 1)
      assert.equal(s.allEdges().length, 1)

      // unresolved + delete
      const refs = s.unresolvedAll()
      assert.equal(refs.length, 1)
      s.deleteUnresolved([refs[0].id])
      assert.equal(s.unresolvedAll().length, 0)

      // re-extract same file replaces, not duplicates
      s.replaceFileGraph("a.ts", {
        nodes: [
          node({ id: "a.ts::parseConfig::1", name: "parseConfig", qualified_name: "parseConfig" }),
        ],
        edges: [],
        unresolved: [],
        file: fileRec("a.ts", { node_count: 1 }),
      })
      assert.equal(s.stats().nodeCount, 1)
      assert.equal(s.stats().edgeCount, 0)

      // deleteFile clears everything for the file
      s.deleteFile("a.ts")
      assert.equal(s.stats().fileCount, 0)
      assert.equal(s.stats().nodeCount, 0)
    } finally {
      s.close()
    }
  }
}

test(
  "memory store satisfies the contract",
  contract(() => createMemoryStore())
)

test(
  "sqlite store satisfies the contract",
  { skip: !Database },
  contract(() => createSqliteStore(":memory:", Database))
)

test("createStore falls back to memory without dbPath or binding", () => {
  assert.equal(createStore().binding, "memory")
  assert.equal(createStore({ forceMemory: true, dbPath: ":memory:" }).binding, "memory")
})

test("createStore uses sqlite when a dbPath + binding are present", { skip: !Database }, () => {
  const s = createStore({ dbPath: ":memory:" })
  assert.equal(s.binding, "sqlite")
  s.close()
})

test("toFtsQuery builds OR-of-prefix tokens and rejects empties", () => {
  assert.equal(toFtsQuery("getUser name"), '"getUser"* OR "name"*')
  assert.equal(toFtsQuery("   "), null)
  assert.equal(toFtsQuery(null), null)
})

import test from "node:test"
import assert from "node:assert/strict"

import { createMemoryStore } from "./store-memory.mjs"
import { buildContext, extractSymbolsFromQuery } from "./context-builder.mjs"

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
    end_line: over.end_line ?? 3,
    end_col: 0,
    docstring: over.docstring ?? null,
    signature: over.signature ?? `function ${over.name}()`,
    visibility: null,
    is_exported: over.is_exported ?? 0,
    is_async: 0,
    is_static: 0,
    return_type: null,
    updated_at: 0,
  }
}

test("extractSymbolsFromQuery pulls identifiers + camel parts, drops stopwords", () => {
  const got = extractSymbolsFromQuery("how does parseConfig call the Loader")
  assert.ok(got.includes("parseConfig"))
  assert.ok(got.includes("parse"))
  assert.ok(got.includes("Config"))
  assert.ok(got.includes("Loader"))
  assert.ok(!got.includes("how"))
  assert.ok(!got.includes("the"))
})

test("extractSymbolsFromQuery handles non-strings", () => {
  assert.deepEqual(extractSymbolsFromQuery(null), [])
  assert.deepEqual(extractSymbolsFromQuery(""), [])
})

function sampleStore() {
  const s = createMemoryStore()
  s.upsertFile({
    path: "config.ts",
    content_hash: "h",
    language: "typescript",
    size: 1,
    modified_at: 1,
    indexed_at: 1,
    node_count: 2,
    errors: null,
  })
  s.upsertFile({
    path: "loader.ts",
    content_hash: "h",
    language: "typescript",
    size: 1,
    modified_at: 1,
    indexed_at: 1,
    node_count: 1,
    errors: null,
  })
  s.insertNodes([
    n({
      id: "config.ts::parseConfig::1",
      name: "parseConfig",
      file_path: "config.ts",
      is_exported: 1,
    }),
    n({
      id: "config.ts::Config::9",
      name: "Config",
      kind: "class",
      file_path: "config.ts",
      start_line: 9,
    }),
    n({ id: "loader.ts::load::1", name: "load", file_path: "loader.ts" }),
    n({ id: "util.ts::unrelated::1", name: "unrelated", file_path: "util.ts" }),
  ])
  s.insertEdges([
    {
      source: "config.ts::parseConfig::1",
      target: "loader.ts::load::1",
      kind: "calls",
      provenance: "resolved",
    },
    {
      source: "config.ts::parseConfig::1",
      target: "config.ts::Config::9",
      kind: "references",
      provenance: "resolved",
    },
  ])
  return s
}

test("buildContext returns entry points, ranked related symbols, snippets and files", () => {
  const s = sampleStore()
  const ctx = buildContext(s, "where is parseConfig defined", {
    getSnippet: (node) => `// ${node.qualified_name}\nbody`,
  })
  assert.ok(ctx.entryPoints.some((e) => e.qualified_name === "parseConfig"))
  // The directly-connected load() / Config should rank above the unrelated node.
  const relatedNames = ctx.related.map((r) => r.node.qualified_name)
  assert.ok(relatedNames.includes("parseConfig"))
  assert.ok(relatedNames.includes("load") || relatedNames.includes("Config"))
  assert.ok(!relatedNames.includes("unrelated"))
  assert.ok(ctx.snippets.length >= 1)
  assert.ok(ctx.relatedFiles.includes("config.ts"))
  assert.match(ctx.summary, /relevant symbol/)
})

test("buildContext honours namedSeeds (explore mode)", () => {
  const s = sampleStore()
  const ctx = buildContext(s, "", { namedSeeds: ["load"], getSnippet: () => "x" })
  assert.ok(ctx.entryPoints.some((e) => e.qualified_name === "load"))
})

test("buildContext on a miss returns an empty, explained result", () => {
  const s = sampleStore()
  const ctx = buildContext(s, "nonexistentThing", { getSnippet: () => "x" })
  assert.equal(ctx.related.length, 0)
  assert.match(ctx.summary, /No indexed symbols matched/)
})

test("buildContext drops oversized snippets and reports them", () => {
  const s = sampleStore()
  const ctx = buildContext(s, "parseConfig", {
    fileCount: 1,
    getSnippet: () => "x".repeat(50000), // far over any per-file cap
  })
  assert.equal(ctx.snippets.length, 0)
  assert.ok(ctx.dropped.length >= 1)
  assert.equal(ctx.dropped[0].reason, "too-large")
})

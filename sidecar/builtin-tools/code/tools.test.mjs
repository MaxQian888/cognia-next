import test from "node:test"
import assert from "node:assert/strict"

import { createCodeGraphTools, CODE_GRAPH_TOOL_NAMES } from "./tools.mjs"

/** A fake resolver implementing the index-service query surface. */
function fakeResolver(over = {}) {
  const node = {
    id: "a.ts::foo::1",
    kind: "function",
    name: "foo",
    qualified_name: "foo",
    file_path: "a.ts",
    start_line: 1,
    end_line: 3,
    signature: "function foo()",
    docstring: "does foo",
    visibility: null,
    is_exported: 1,
    is_async: 0,
  }
  let synced = 0
  return {
    _node: node,
    get syncCount() {
      return synced
    },
    async syncStale() {
      synced++
    },
    async ensureIndexed() {},
    status: () => ({
      indexed: true,
      fileCount: 1,
      nodeCount: 1,
      edgeCount: 0,
      languages: { typescript: 1 },
      binding: "memory",
    }),
    search: () => [node],
    getNode: (t) => (t === node.id || t === node.qualified_name ? node : null),
    snippetFor: () => "function foo() { return 1; }",
    callers: () => [{ node, distance: 1 }],
    callees: () => [{ node, distance: 1 }],
    impact: () => [{ node, distance: 1 }],
    context: () => ({
      summary: "1 relevant symbol",
      entryPoints: [node],
      related: [{ node, score: 42 }],
      snippets: [{ qualified_name: "foo", file: "a.ts", text: "function foo()" }],
      relatedFiles: ["a.ts"],
      dropped: [],
    }),
    files: () => [{ path: "a.ts", language: "typescript", node_count: 1, errors: null }],
    stalenessBanner: () => "",
    ...over,
  }
}

function byName(tools) {
  return new Map(tools.map((t) => [t.name, t]))
}
function parse(result) {
  assert.equal(result.content[0].type, "text")
  return JSON.parse(result.content[0].text)
}

test("createCodeGraphTools exposes exactly the named tool set, all callable", () => {
  const tools = createCodeGraphTools(fakeResolver())
  assert.deepEqual(tools.map((t) => t.name).sort(), [...CODE_GRAPH_TOOL_NAMES].sort())
  for (const t of tools) assert.equal(typeof t.handler, "function")
})

test("every tool syncs the index before answering", async () => {
  const resolver = fakeResolver()
  const tools = byName(createCodeGraphTools(resolver))
  await tools.get("codegraph_status").handler({})
  assert.equal(resolver.syncCount, 1)
})

test("codegraph_search returns compact rows", async () => {
  const tools = byName(createCodeGraphTools(fakeResolver()))
  const out = parse(await tools.get("codegraph_search").handler({ query: "foo", limit: 20 }))
  assert.equal(out.results[0].qualified_name, "foo")
  assert.equal(out.results[0].id, "a.ts::foo::1")
})

test("codegraph_node returns source + metadata", async () => {
  const tools = byName(createCodeGraphTools(fakeResolver()))
  const out = parse(await tools.get("codegraph_node").handler({ target: "foo" }))
  assert.match(out.source, /return 1/)
  assert.equal(out.is_exported, true)
})

test("codegraph_node errors clearly when the symbol is unknown", async () => {
  const tools = byName(createCodeGraphTools(fakeResolver()))
  const res = await tools.get("codegraph_node").handler({ target: "missing" })
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /no indexed symbol matches/)
})

test("callers / callees / impact carry distance", async () => {
  const tools = byName(createCodeGraphTools(fakeResolver()))
  const callers = parse(await tools.get("codegraph_callers").handler({ target: "foo", depth: 3 }))
  assert.equal(callers.callers[0].distance, 1)
  const impact = parse(await tools.get("codegraph_impact").handler({ target: "foo", depth: 4 }))
  assert.equal(impact.impactCount, 1)
})

test("codegraph_context / explore format the composite result", async () => {
  const tools = byName(createCodeGraphTools(fakeResolver()))
  const ctx = parse(await tools.get("codegraph_context").handler({ query: "foo" }))
  assert.equal(ctx.entryPoints[0].qualified_name, "foo")
  assert.equal(ctx.snippets[0].source, "function foo()")
  const exp = parse(await tools.get("codegraph_explore").handler({ seeds: ["foo"] }))
  assert.match(exp.summary, /relevant symbol/)
})

test("the staleness banner is prepended as a warning field", async () => {
  const resolver = fakeResolver({ stalenessBanner: () => "⚠️ 2 file(s) pending" })
  const tools = byName(createCodeGraphTools(resolver))
  const out = parse(await tools.get("codegraph_status").handler({}))
  assert.match(out.warning, /pending/)
})

test("codegraph_files surfaces per-file symbol counts", async () => {
  const tools = byName(createCodeGraphTools(fakeResolver()))
  const out = parse(await tools.get("codegraph_files").handler({}))
  assert.equal(out.files[0].symbols, 1)
})

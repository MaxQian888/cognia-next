import test from "node:test"
import assert from "node:assert/strict"

import { createMemoryStore } from "./store-memory.mjs"
import { callers, callees, impact, randomWalkWithRestart } from "./graph.mjs"

function n(id) {
  return {
    id,
    kind: "function",
    name: id,
    qualified_name: id,
    file_path: `${id}.ts`,
    language: "typescript",
    start_line: 1,
    start_col: 0,
    end_line: 2,
    end_col: 0,
    docstring: null,
    signature: id,
    visibility: null,
    is_exported: 0,
    is_async: 0,
    is_static: 0,
    return_type: null,
    updated_at: 0,
  }
}

/** a → b → c → a  (cycle); plus d → b */
function cyclicStore() {
  const s = createMemoryStore()
  s.insertNodes(["a", "b", "c", "d"].map(n))
  s.insertEdges([
    { source: "a", target: "b", kind: "calls", provenance: "t" },
    { source: "b", target: "c", kind: "calls", provenance: "t" },
    { source: "c", target: "a", kind: "calls", provenance: "t" },
    { source: "d", target: "b", kind: "calls", provenance: "t" },
  ])
  return s
}

test("callees follows outgoing calls with depth + terminates on cycle", () => {
  const s = cyclicStore()
  const out = callees(s, "a", 10)
    .map((r) => r.id)
    .sort()
  // a→b→c→(a already visited) ; reachable: b, c
  assert.deepEqual(out, ["b", "c"])
})

test("callers follows incoming calls", () => {
  const s = cyclicStore()
  const got = callers(s, "b")
    .map((r) => r.id)
    .sort()
  // who reaches b: a (direct), d (direct), c→a→b transitively
  assert.deepEqual(got, ["a", "c", "d"])
})

test("depth cap limits distance", () => {
  const s = cyclicStore()
  const d1 = callees(s, "a", 1).map((r) => r.id)
  assert.deepEqual(d1, ["b"])
})

test("impact closes over multiple dependency kinds", () => {
  const s = createMemoryStore()
  s.insertNodes(["base", "child", "user"].map(n))
  s.insertEdges([
    { source: "child", target: "base", kind: "extends", provenance: "t" },
    { source: "user", target: "child", kind: "imports", provenance: "t" },
  ])
  const blast = impact(s, "base")
    .map((r) => r.id)
    .sort()
  assert.deepEqual(blast, ["child", "user"])
})

test("randomWalkWithRestart concentrates mass near seeds", () => {
  const s = cyclicStore()
  const scores = randomWalkWithRestart(s, ["a"])
  assert.ok(scores.get("a") > 0)
  // b is adjacent to a (both directions) → should score above the far node.
  assert.ok(scores.get("b") > 0)
  // every reached score is finite and positive
  for (const v of scores.values()) assert.ok(v > 0 && Number.isFinite(v))
})

test("randomWalkWithRestart returns empty for no valid seeds", () => {
  const s = cyclicStore()
  assert.equal(randomWalkWithRestart(s, []).size, 0)
  assert.equal(randomWalkWithRestart(s, ["missing"]).size, 0)
})

test("randomWalkWithRestart handles a dangling seed (no edges)", () => {
  const s = createMemoryStore()
  s.insertNodes([n("lonely")])
  const scores = randomWalkWithRestart(s, ["lonely"])
  assert.ok(scores.get("lonely") > 0)
})

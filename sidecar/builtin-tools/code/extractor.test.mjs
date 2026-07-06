import test from "node:test"
import assert from "node:assert/strict"

import { extractFile, nodeId, fileNodeId } from "./extractor.mjs"

function byQname(nodes) {
  const m = new Map()
  for (const n of nodes) m.set(n.qualified_name, n)
  return m
}
function refs(unresolved) {
  return unresolved.map((u) => `${u.reference_kind}:${u.reference_name}`)
}

test("nodeId / fileNodeId are deterministic", () => {
  assert.equal(fileNodeId("a.ts"), "a.ts")
  assert.equal(nodeId("a.ts", "foo", 3), "a.ts::foo::3")
})

test("unsupported language returns empty graph with error", async () => {
  const r = await extractFile("notes.md", "# hi")
  assert.equal(r.language, null)
  assert.deepEqual(r.nodes, [])
  assert.ok(r.errors.includes("unsupported language"))
})

test("TypeScript: symbols, kinds, contains edges, calls/imports/inheritance", async () => {
  const src = `// greets a user
export async function greet(name: string): Promise<string> { return format(name); }
export class Service extends Base implements Iface {
  run() { return this.greet(); }
}
const handler = () => doWork();
const MAX = 5;
import { format } from "./fmt";
`
  const r = await extractFile("a.ts", src)
  const m = byQname(r.nodes)
  assert.equal(m.get("a.ts").kind, "file")
  assert.equal(m.get("greet").kind, "function")
  assert.equal(m.get("greet").is_async, 1)
  assert.equal(m.get("greet").is_exported, 1)
  assert.match(m.get("greet").docstring ?? "", /greets a user/)
  assert.equal(m.get("Service").kind, "class")
  assert.equal(m.get("Service.run").kind, "method")
  assert.equal(m.get("handler").kind, "function") // arrow fn const → function
  assert.equal(m.get("MAX").kind, "constant")

  // every symbol has a contains edge from its container
  const contains = r.edges.filter((e) => e.kind === "contains")
  assert.equal(contains.length, r.nodes.length - 1)
  const runContains = contains.find((e) => e.target === m.get("Service.run").id)
  assert.equal(runContains.source, m.get("Service").id)

  const rk = refs(r.unresolved)
  assert.ok(rk.includes("calls:format"))
  assert.ok(rk.includes("calls:greet"))
  assert.ok(rk.includes("calls:doWork"))
  assert.ok(rk.includes("extends:Base"))
  assert.ok(rk.includes("extends:Iface"))
  assert.ok(rk.includes("imports:./fmt"))
})

test("Python: constants vs variables, methods, bases, imports, docstring", async () => {
  const src = `import os
from a.b import thing
GLOBAL_X = 1
local_count = 2
def top():
    return helper()
class Animal(Base):
    """an animal"""
    def speak(self):
        return self.noise()
`
  const r = await extractFile("m.py", src)
  const m = byQname(r.nodes)
  assert.equal(m.get("GLOBAL_X").kind, "constant")
  assert.equal(m.get("local_count").kind, "variable")
  assert.equal(m.get("top").kind, "function")
  assert.equal(m.get("Animal").kind, "class")
  assert.match(m.get("Animal").docstring ?? "", /an animal/)
  assert.equal(m.get("Animal.speak").kind, "method")
  const rk = refs(r.unresolved)
  assert.ok(rk.includes("imports:os"))
  assert.ok(rk.includes("imports:a.b"))
  assert.ok(rk.includes("calls:helper"))
  assert.ok(rk.includes("extends:Base"))
})

test("Python: locals inside a function body are not symbols", async () => {
  const src = `def f():
    temp = 1
    return temp
`
  const r = await extractFile("p.py", src)
  const names = r.nodes.map((n) => n.qualified_name)
  assert.ok(names.includes("f"))
  assert.ok(!names.includes("f.temp"))
  assert.ok(!names.includes("temp"))
})

test("Rust: structs/traits/impl methods + implements edge", async () => {
  const src = `use crate::foo::Bar;
pub struct Widget { x: i32 }
pub trait Draw { fn draw(&self); }
impl Draw for Widget { fn draw(&self) { render(); } }
pub fn build() -> Widget { Widget { x: 0 } }
`
  const r = await extractFile("lib.rs", src)
  const m = byQname(r.nodes)
  assert.equal(m.get("Widget").kind, "struct")
  assert.equal(m.get("Widget").is_exported, 1)
  assert.equal(m.get("Draw").kind, "trait")
  assert.equal(m.get("build").kind, "function")
  const rk = refs(r.unresolved)
  assert.ok(rk.includes("imports:crate::foo::Bar"))
  assert.ok(rk.includes("calls:render"))
  assert.ok(rk.includes("implements:Draw"))
})

test("parse of malformed source still returns the file node, no throw", async () => {
  const r = await extractFile("bad.ts", "function (((")
  assert.equal(r.nodes[0].kind, "file")
  assert.ok(Array.isArray(r.errors))
})

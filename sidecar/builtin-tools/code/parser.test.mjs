import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import fs from "node:fs"
import path from "node:path"

import {
  getParser,
  grammarSearchDirs,
  resetParsers,
  resolveGrammarWasm,
  standaloneResourceDir,
  treeSitterInitOptions,
} from "./parser.mjs"

test("grammarSearchDirs puts the co-located grammars/ dir first", () => {
  const dirs = grammarSearchDirs("/base")
  assert.ok(dirs[0].endsWith(path.join("grammars")))
})

test("grammarSearchDirs surfaces the tree-sitter-wasms dev dir from the real base", () => {
  // From the actual module dir, the node_modules walk finds tree-sitter-wasms.
  const dirs = grammarSearchDirs()
  assert.ok(dirs.some((d) => d.includes("tree-sitter-wasms")))
})

test("standalone Bun resolves the runtime and grammars beside the executable", () => {
  const executable = path.join("/opt", "cognia", "cognia-agent")
  const resourceDir = standaloneResourceDir({ bunStandalone: true, execPath: executable })
  assert.equal(resourceDir, path.dirname(executable))
  assert.equal(
    grammarSearchDirs("/$bunfs/root", resourceDir)[0],
    path.join(resourceDir, "grammars")
  )
  assert.equal(
    treeSitterInitOptions(resourceDir).locateFile("tree-sitter.wasm"),
    path.join(resourceDir, "tree-sitter.wasm")
  )
})

test("source runtimes keep web-tree-sitter's default runtime resolution", () => {
  assert.equal(standaloneResourceDir({ bunStandalone: false, execPath: "/usr/bin/node" }), null)
  assert.equal(treeSitterInitOptions(null), undefined)
})

test("resolveGrammarWasm finds a prebuilt grammar in node_modules (dev)", () => {
  // From the real module dir, the dev branch (tree-sitter-wasms) must resolve.
  const wasm = resolveGrammarWasm("typescript")
  assert.ok(wasm.endsWith("tree-sitter-typescript.wasm"))
  assert.ok(fs.existsSync(wasm))
})

test("resolveGrammarWasm prefers a co-located grammars/ dir when present", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cg-grammar-"))
  try {
    const gdir = path.join(base, "grammars")
    fs.mkdirSync(gdir)
    const target = path.join(gdir, "tree-sitter-rust.wasm")
    fs.writeFileSync(target, "stub")
    assert.equal(resolveGrammarWasm("rust", base), target)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test("resolveGrammarWasm throws a structured error for a missing grammar", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cg-empty-"))
  try {
    assert.throws(() => resolveGrammarWasm("rust", base), /grammar wasm not found for "rust"/)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test("getParser rejects unknown grammar keys", async () => {
  await assert.rejects(() => getParser("cobol"), /unknown grammar key/)
})

test("getParser parses real source for every supported grammar", async () => {
  const cases = [
    ["typescript", "function f(): void {}"],
    ["tsx", "const A = () => <div/>;"],
    ["rust", "fn main() {}"],
    ["python", "def f():\n    pass\n"],
  ]
  for (const [key, src] of cases) {
    const p = await getParser(key)
    const tree = p.parse(src)
    assert.ok(tree.rootNode, `${key} produced a root node`)
    assert.ok(tree.rootNode.namedChildren.length >= 1, `${key} has children`)
  }
  resetParsers()
})

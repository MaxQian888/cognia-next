import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createLspTools,
  LSP_TOOL_NAMES,
  formatLocations,
  formatHover,
  formatSymbols,
} from "../lsp.mjs"

function fakeResolver({ requestResult, diagnostics } = {}) {
  const calls = { request: [], getDiagnostics: [] }
  return {
    calls,
    async request(file, method, payload) {
      calls.request.push({ file, method, payload })
      return requestResult
    },
    async getDiagnostics(file) {
      calls.getDiagnostics.push(file)
      return diagnostics ?? []
    },
  }
}

const find = (tools, name) => tools.find((t) => t.name === name)

test("createLspTools exposes the documented tool set", () => {
  const tools = createLspTools(fakeResolver())
  assert.deepEqual(tools.map((t) => t.name).sort(), [...LSP_TOOL_NAMES].sort())
  for (const t of tools) assert.equal(typeof t.handler, "function")
})

test("goto_definition converts 1-based position to 0-based and formats", async () => {
  const resolver = fakeResolver({
    requestResult: { uri: "file:///proj/a.ts", range: { start: { line: 4, character: 2 } } },
  })
  const tools = createLspTools(resolver)
  const res = await find(tools, "lsp_goto_definition").handler({
    file: "/proj/a.ts",
    line: 10,
    character: 3,
  })
  assert.equal(resolver.calls.request[0].method, "definition")
  assert.deepEqual(resolver.calls.request[0].payload.position, { line: 9, character: 2 })
  assert.match(res.content[0].text, /a\.ts:5:3/)
})

test("goto_definition returns resolver failures as compact tool errors", async () => {
  const resolver = fakeResolver()
  resolver.request = async () => {
    throw new Error("resolver down")
  }
  const tools = createLspTools(resolver)
  const res = await find(tools, "lsp_goto_definition").handler({
    file: "/proj/a.ts",
    line: 10,
    character: 3,
  })
  assert.equal(res.isError, true)
  assert.equal(res.content[0].type, "text")
  assert.match(res.content[0].text, /lsp_goto_definition: resolver down/)
})

test("find_references routes to the references method", async () => {
  const resolver = fakeResolver({ requestResult: [] })
  const tools = createLspTools(resolver)
  const res = await find(tools, "lsp_find_references").handler({
    file: "/proj/a.ts",
    line: 1,
    character: 1,
  })
  assert.equal(resolver.calls.request[0].method, "references")
  assert.equal(res.content[0].text, "No results.")
})

test("hover renders markdown content value", async () => {
  const resolver = fakeResolver({
    requestResult: { contents: { kind: "markdown", value: "fn foo()" } },
  })
  const tools = createLspTools(resolver)
  const res = await find(tools, "lsp_hover").handler({ file: "/p/a.ts", line: 2, character: 2 })
  assert.equal(res.content[0].text, "fn foo()")
})

test("document_symbols routes to the documentSymbol method", async () => {
  const resolver = fakeResolver({
    requestResult: [{ name: "Foo", kind: 5, range: { start: { line: 0 } } }],
  })
  const tools = createLspTools(resolver)
  const res = await find(tools, "lsp_document_symbols").handler({ file: "/p/a.ts" })
  assert.equal(resolver.calls.request[0].method, "documentSymbol")
  assert.match(res.content[0].text, /class Foo/)
})

test("diagnostics formats cached errors and warnings", async () => {
  const resolver = fakeResolver({
    diagnostics: [{ range: { start: { line: 0, character: 0 } }, severity: 1, message: "boom" }],
  })
  const tools = createLspTools(resolver)
  const res = await find(tools, "lsp_diagnostics").handler({ file: "/p/a.ts" })
  assert.match(res.content[0].text, /1:1 ERROR boom/)
})

test("diagnostics reports clean files", async () => {
  const resolver = fakeResolver({ diagnostics: [] })
  const tools = createLspTools(resolver)
  const res = await find(tools, "lsp_diagnostics").handler({ file: "/p/a.ts" })
  assert.equal(res.content[0].text, "No diagnostics.")
})

test("formatLocations handles LocationLink and empty input", () => {
  assert.equal(formatLocations(null), "No results.")
  assert.equal(formatLocations([]), "No results.")
  assert.match(
    formatLocations({
      targetUri: "file:///x/y.go",
      targetRange: { start: { line: 0, character: 0 } },
    }),
    /y\.go:1:1/
  )
})

test("formatHover handles string and array contents", () => {
  assert.equal(formatHover({ contents: "plain" }), "plain")
  assert.equal(formatHover({ contents: ["a", { value: "b" }] }), "a\n\nb")
  assert.equal(formatHover(null), "No hover information.")
})

test("formatSymbols renders an indented tree", () => {
  const out = formatSymbols([
    {
      name: "Foo",
      kind: 5,
      range: { start: { line: 0 } },
      children: [{ name: "bar", kind: 6, range: { start: { line: 1 } } }],
    },
  ])
  assert.equal(out, "class Foo (L1)\n  method bar (L2)")
  assert.equal(formatSymbols([]), "No symbols.")
})

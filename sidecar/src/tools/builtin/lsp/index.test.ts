import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createLspTools,
  LSP_TOOL_NAMES,
  formatLocations,
  formatHover,
  formatSymbols,
} from "./index.ts"
import { findTool, firstText } from "../../../../test-support/tool-result.ts"

interface RequestCall {
  file: string
  method: string
  payload?: { position?: unknown }
}

function fakeResolver({
  requestResult,
  diagnostics,
}: { requestResult?: unknown; diagnostics?: unknown[] } = {}) {
  const calls: { request: RequestCall[]; getDiagnostics: string[] } = {
    request: [],
    getDiagnostics: [],
  }
  return {
    calls,
    async request(
      file: string,
      method: string,
      payload?: Record<string, unknown>
    ): Promise<unknown> {
      calls.request.push({ file, method, payload })
      return requestResult
    },
    async getDiagnostics(file: string): Promise<unknown[]> {
      calls.getDiagnostics.push(file)
      return diagnostics ?? []
    },
  }
}

const find = findTool

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
  assert.equal(resolver.calls.request[0]!.method, "definition")
  assert.deepEqual(resolver.calls.request[0]!.payload?.position, { line: 9, character: 2 })
  assert.match(firstText(res), /a\.ts:5:3/)
})

test("goto_definition returns resolver failures as compact tool errors", async () => {
  const resolver = fakeResolver()
  resolver.request = async (): Promise<unknown> => {
    throw new Error("resolver down")
  }
  const tools = createLspTools(resolver)
  const res = await find(tools, "lsp_goto_definition").handler({
    file: "/proj/a.ts",
    line: 10,
    character: 3,
  })
  assert.equal(res.isError, true)
  assert.match(firstText(res), /lsp_goto_definition: resolver down/)
})

test("find_references routes to the references method", async () => {
  const resolver = fakeResolver({ requestResult: [] })
  const tools = createLspTools(resolver)
  const res = await find(tools, "lsp_find_references").handler({
    file: "/proj/a.ts",
    line: 1,
    character: 1,
  })
  assert.equal(resolver.calls.request[0]!.method, "references")
  assert.equal(firstText(res), "No results.")
})

test("hover renders markdown content value", async () => {
  const resolver = fakeResolver({
    requestResult: { contents: { kind: "markdown", value: "fn foo()" } },
  })
  const tools = createLspTools(resolver)
  const res = await find(tools, "lsp_hover").handler({ file: "/p/a.ts", line: 2, character: 2 })
  assert.equal(firstText(res), "fn foo()")
})

test("document_symbols routes to the documentSymbol method", async () => {
  const resolver = fakeResolver({
    requestResult: [{ name: "Foo", kind: 5, range: { start: { line: 0 } } }],
  })
  const tools = createLspTools(resolver)
  const res = await find(tools, "lsp_document_symbols").handler({ file: "/p/a.ts" })
  assert.equal(resolver.calls.request[0]!.method, "documentSymbol")
  assert.match(firstText(res), /class Foo/)
})

test("diagnostics formats cached errors and warnings", async () => {
  const resolver = fakeResolver({
    diagnostics: [{ range: { start: { line: 0, character: 0 } }, severity: 1, message: "boom" }],
  })
  const tools = createLspTools(resolver)
  const res = await find(tools, "lsp_diagnostics").handler({ file: "/p/a.ts" })
  assert.match(firstText(res), /1:1 ERROR boom/)
})

test("diagnostics reports clean files", async () => {
  const resolver = fakeResolver({ diagnostics: [] })
  const tools = createLspTools(resolver)
  const res = await find(tools, "lsp_diagnostics").handler({ file: "/p/a.ts" })
  assert.equal(firstText(res), "No diagnostics.")
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

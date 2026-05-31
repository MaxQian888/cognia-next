import { test } from "node:test"
import assert from "node:assert/strict"
import {
  makePostToolUseDiagnostics,
  buildLspHooks,
  extractEditedPath,
  EDIT_TOOLS,
} from "./lsp-hooks.mjs"

function fakeResolver(diagnostics) {
  const calls = []
  return {
    calls,
    async getDiagnostics(file) {
      calls.push(file)
      return diagnostics ?? []
    },
  }
}

test("extractEditedPath reads file_path / path / notebook_path", () => {
  assert.equal(extractEditedPath("Edit", { file_path: "/a.ts" }), "/a.ts")
  assert.equal(extractEditedPath("Write", { path: "/b.ts" }), "/b.ts")
  assert.equal(extractEditedPath("NotebookEdit", { notebook_path: "/c.ipynb" }), "/c.ipynb")
  assert.equal(extractEditedPath("Edit", null), null)
})

test("EDIT_TOOLS contains the mutating file tools", () => {
  for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) assert.ok(EDIT_TOOLS.has(t))
  assert.equal(EDIT_TOOLS.has("Read"), false)
})

test("hook appends additionalContext when diagnostics exist", async () => {
  const resolver = fakeResolver([
    { range: { start: { line: 0, character: 0 } }, severity: 1, message: "boom", source: "ts" },
  ])
  const hook = makePostToolUseDiagnostics(resolver)
  const out = await hook({ tool_name: "Edit", tool_input: { file_path: "/proj/a.ts" } })
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse")
  assert.match(out.hookSpecificOutput.additionalContext, /please fix/)
  assert.match(out.hookSpecificOutput.additionalContext, /1:1 ERROR boom/)
  assert.deepEqual(resolver.calls, ["/proj/a.ts"])
})

test("hook is a no-op for non-edit tools", async () => {
  const resolver = fakeResolver([{ range: { start: {} }, severity: 1, message: "x" }])
  const hook = makePostToolUseDiagnostics(resolver)
  const out = await hook({ tool_name: "Read", tool_input: { file_path: "/a.ts" } })
  assert.deepEqual(out, {})
  assert.equal(resolver.calls.length, 0)
})

test("hook is a no-op when there are no diagnostics", async () => {
  const resolver = fakeResolver([])
  const hook = makePostToolUseDiagnostics(resolver)
  const out = await hook({ tool_name: "Write", tool_input: { file_path: "/a.ts" } })
  assert.deepEqual(out, {})
})

test("hook is a no-op when resolver is null", async () => {
  const hook = makePostToolUseDiagnostics(null)
  const out = await hook({ tool_name: "Edit", tool_input: { file_path: "/a.ts" } })
  assert.deepEqual(out, {})
})

test("hook swallows resolver errors", async () => {
  const hook = makePostToolUseDiagnostics({
    async getDiagnostics() {
      throw new Error("lsp down")
    },
  })
  const out = await hook({ tool_name: "Edit", tool_input: { file_path: "/a.ts" } })
  assert.deepEqual(out, {})
})

test("buildLspHooks returns undefined without a resolver, structure with one", () => {
  assert.equal(buildLspHooks(null), undefined)
  const hooks = buildLspHooks(fakeResolver([]))
  assert.ok(Array.isArray(hooks.PostToolUse))
  assert.equal(typeof hooks.PostToolUse[0].hooks[0], "function")
})

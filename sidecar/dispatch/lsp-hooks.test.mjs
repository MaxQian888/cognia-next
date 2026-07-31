import { test } from "node:test"
import assert from "node:assert/strict"
import {
  makePostToolUseDiagnostics,
  buildLspHooks,
  extractEditedPath,
  EDIT_TOOLS,
  createDiagnosticsLedger,
  diagnosticIdentity,
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

/** Resolver whose diagnostics can change between edits. */
function mutableResolver() {
  const state = { diags: [] }
  return {
    state,
    async getDiagnostics() {
      return state.diags
    },
  }
}

const D = (message, severity = 1, extra = {}) => ({
  range: { start: { line: 0, character: 0 } },
  severity,
  message,
  source: "ts",
  ...extra,
})

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

// --- diagnostics ledger ---------------------------------------------------

test("diagnosticIdentity is position-independent (same message, different line)", () => {
  const a = diagnosticIdentity(D("boom", 1, { range: { start: { line: 0, character: 0 } } }))
  const b = diagnosticIdentity(D("boom", 1, { range: { start: { line: 42, character: 9 } } }))
  assert.equal(a, b)
  assert.notEqual(diagnosticIdentity(D("boom")), diagnosticIdentity(D("kaboom")))
})

test("ledger surfaces only diagnostics new since the last pass to a file", async () => {
  const resolver = mutableResolver()
  const ledger = createDiagnosticsLedger()
  const hook = makePostToolUseDiagnostics(resolver, { ledger })
  const edit = () => hook({ tool_name: "Edit", tool_input: { file_path: "/proj/a.ts" } })

  // First edit: a pre-existing error surfaces once (establishes the baseline).
  resolver.state.diags = [D("pre-existing")]
  const first = await edit()
  assert.match(first.hookSpecificOutput.additionalContext, /pre-existing/)

  // Second edit, same diagnostics → nothing new → no context appended.
  const second = await edit()
  assert.deepEqual(second, {})

  // Third edit introduces a NEW error → only the new one is reported.
  resolver.state.diags = [D("pre-existing"), D("brand new")]
  const third = await edit()
  assert.match(third.hookSpecificOutput.additionalContext, /brand new/)
  assert.doesNotMatch(third.hookSpecificOutput.additionalContext, /pre-existing/)
})

test("ledger re-reports a diagnostic that was fixed and then reappears", async () => {
  const resolver = mutableResolver()
  const ledger = createDiagnosticsLedger()
  const hook = makePostToolUseDiagnostics(resolver, { ledger })
  const edit = () => hook({ tool_name: "Edit", tool_input: { file_path: "/a.ts" } })

  resolver.state.diags = [D("flaky")]
  assert.match((await edit()).hookSpecificOutput.additionalContext, /flaky/)
  resolver.state.diags = [] // fixed
  assert.deepEqual(await edit(), {})
  resolver.state.diags = [D("flaky")] // regressed
  assert.match((await edit()).hookSpecificOutput.additionalContext, /flaky/)
})

test("ledger.seed suppresses baseline diagnostics on the first reporting pass", async () => {
  const resolver = mutableResolver()
  const ledger = createDiagnosticsLedger()
  ledger.seed("/a.ts", [D("was here before the edit")])
  const hook = makePostToolUseDiagnostics(resolver, { ledger })
  resolver.state.diags = [D("was here before the edit")]
  const out = await hook({ tool_name: "Edit", tool_input: { file_path: "/a.ts" } })
  assert.deepEqual(out, {}) // seeded diagnostic is not "new"
})

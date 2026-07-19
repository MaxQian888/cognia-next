import { test } from "node:test"
import assert from "node:assert/strict"

import {
  SERVER_NAME,
  SERVER_VERSION,
  TOOL_NAMES_BY_CATEGORY,
  buildCogniaToolsServer,
  namesForDisabledCategories,
  namespacedName,
} from "../index.mjs"

test("server name + version match the shared JSON", () => {
  assert.equal(SERVER_NAME, "cognia-tools")
  assert.match(SERVER_VERSION, /^\d+\.\d+\.\d+$/)
})

test("TOOL_NAMES_BY_CATEGORY exposes every category bucket", () => {
  const ids = Object.keys(TOOL_NAMES_BY_CATEGORY).sort()
  assert.deepEqual(ids, [
    "astGrep",
    "codeGraph",
    "coreFiles",
    "dependencyResearch",
    "environment",
    "fileExtras",
    "git",
    "lsp",
    "process",
    "shellAdvanced",
    "terminalRepl",
    "webclone",
  ])
})

test("buildCogniaToolsServer returns null when no categories enabled", () => {
  assert.equal(buildCogniaToolsServer({ enabled: {} }), null)
  assert.equal(
    buildCogniaToolsServer({
      enabled: {
        fileExtras: false,
        git: false,
        process: false,
        environment: false,
        shellAdvanced: false,
        terminalRepl: false,
      },
    }),
    null
  )
})

test("buildCogniaToolsServer returns null when enabled is undefined", () => {
  assert.equal(buildCogniaToolsServer({ enabled: undefined }), null)
})

test("buildCogniaToolsServer returns a config when at least one category enabled", () => {
  const server = buildCogniaToolsServer({ enabled: { git: true } })
  assert.notEqual(server, null)
  // Shape sniff — SDK returns { name, instance, type:'sdk' } in some versions.
  assert.equal(server?.name, "cognia-tools")
})

test("buildCogniaToolsServer composes tools from all enabled categories", () => {
  const all = buildCogniaToolsServer({
    enabled: {
      fileExtras: true,
      git: true,
      process: true,
      environment: true,
      shellAdvanced: true,
      terminalRepl: true,
    },
  })
  assert.notEqual(all, null)
  // The instance method `getTools()` (or similar) isn't always exposed; we
  // just verify object construction didn't throw and that name is right.
  assert.equal(all?.name, "cognia-tools")
})

test("buildCogniaToolsServer accepts a per-tool timeout (incl. 0 to disable)", () => {
  // The read-only deadline wrapping is exercised in read-only-timeout.test.mjs;
  // here we just lock that the param threads through construction on both the
  // default-net and disabled paths.
  const explicit = buildCogniaToolsServer({ enabled: { git: true }, toolExecutionTimeoutMs: 5000 })
  assert.equal(explicit?.name, "cognia-tools")
  const disabled = buildCogniaToolsServer({ enabled: { git: true }, toolExecutionTimeoutMs: 0 })
  assert.equal(disabled?.name, "cognia-tools")
})

test("namespacedName prepends the SDK prefix", () => {
  assert.equal(namespacedName("file_hash"), "mcp__cognia-tools__file_hash")
})

test("namesForDisabledCategories returns nothing when everything is enabled", () => {
  const out = namesForDisabledCategories({
    fileExtras: true,
    coreFiles: true,
    git: true,
    process: true,
    environment: true,
    shellAdvanced: true,
    terminalRepl: true,
    lsp: true,
    codeGraph: true,
    astGrep: true,
    dependencyResearch: true,
    webclone: true,
  })
  assert.deepEqual(out, [])
})

test("namesForDisabledCategories returns prefixed names for off categories", () => {
  const out = namesForDisabledCategories({
    fileExtras: false,
    git: true,
    process: false,
    environment: true,
    shellAdvanced: false,
    terminalRepl: true,
  })
  assert.ok(out.includes("mcp__cognia-tools__file_hash"))
  assert.ok(out.includes("mcp__cognia-tools__shell_execute_advanced"))
  assert.ok(!out.includes("mcp__cognia-tools__git_status"))
})

test("namesForDisabledCategories returns everything when enabled is undefined", () => {
  const out = namesForDisabledCategories(undefined)
  // Sanity: should include at least one name from each category.
  assert.ok(out.some((n) => n.endsWith("file_hash")))
  assert.ok(out.some((n) => n.endsWith("git_status")))
  assert.ok(out.some((n) => n.endsWith("list_processes")))
  assert.ok(out.some((n) => n.endsWith("system_info")))
  assert.ok(out.some((n) => n.endsWith("shell_execute_advanced")))
  assert.ok(out.some((n) => n.endsWith("terminal_repl_spawn")))
})

test("every tool name is unique across categories", () => {
  const seen = new Set()
  for (const names of Object.values(TOOL_NAMES_BY_CATEGORY)) {
    for (const n of names) {
      assert.equal(seen.has(n), false, `duplicate name: ${n}`)
      seen.add(n)
    }
  }
})

test("no tool name collides with SDK built-ins", () => {
  const sdkBuiltIns = new Set([
    "Bash",
    "Read",
    "Write",
    "Edit",
    "MultiEdit",
    "Glob",
    "Grep",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
    "TaskCreate",
    "TaskGet",
    "TaskList",
    "TaskUpdate",
  ])
  for (const [category, names] of Object.entries(TOOL_NAMES_BY_CATEGORY)) {
    // The coreFiles suite intentionally names its todo tool exactly
    // "TodoWrite" so the renderer's existing task card renders the ai-sdk
    // path with zero changes. It is default-OFF on the Anthropic path (and
    // namespaced there), so no SDK-level collision can occur.
    if (category === "coreFiles") continue
    for (const n of names) {
      assert.equal(sdkBuiltIns.has(n), false, `${n} collides with SDK built-in`)
    }
  }
})

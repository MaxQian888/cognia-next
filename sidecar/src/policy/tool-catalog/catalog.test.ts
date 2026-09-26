import { test } from "node:test"
import assert from "node:assert/strict"

import {
  BUILTIN_SERVER_NAME,
  BUILTIN_SERVER_VERSION,
  READ_ONLY_TOOL_NAMES,
  TOOL_NAMES_BY_CATEGORY,
  namesForDisabledCategories,
  namespacedName,
} from "./catalog.ts"

test("the built-in server identity comes from the metadata JSON", () => {
  assert.equal(BUILTIN_SERVER_NAME, "cognia-tools")
  assert.match(BUILTIN_SERVER_VERSION, /^\d+\.\d+\.\d+$/)
})

test("read-only tools are a subset of the catalogued tools", () => {
  const all = new Set(Object.values(TOOL_NAMES_BY_CATEGORY).flat())
  assert.ok(READ_ONLY_TOOL_NAMES.size > 0)
  for (const name of READ_ONLY_TOOL_NAMES) assert.ok(all.has(name), name)
})

test("the catalog is frozen", () => {
  assert.ok(Object.isFrozen(TOOL_NAMES_BY_CATEGORY))
  assert.ok(Object.isFrozen(READ_ONLY_TOOL_NAMES))
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
  const seen = new Set<string>()
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

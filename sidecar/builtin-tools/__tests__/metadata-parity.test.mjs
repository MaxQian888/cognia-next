// Guard: the shared metadata (lib/settings/builtin-tools-data.json) and the
// actual sidecar tool implementations must never drift. This single test locks
// down the whole class of parity bugs the two explore passes flagged:
//   - a tool listed in metadata but not implemented (or vice-versa)
//   - a requiresApproval flag that disagrees with READ_ONLY_TOOL_NAMES (which
//     plan mode trusts on the ai-sdk path)
//   - CORE_TOOL_NAMES order/membership drifting from the coreFiles metadata
//   - a host-routed tool (web/skill/slash/Task/dispatch_agent) accidentally
//     declared as a sidecar-resident built-in
import { test } from "node:test"
import assert from "node:assert/strict"

import data from "../../../lib/settings/builtin-tools-data.json" with { type: "json" }
import { collectCogniaToolDefs, READ_ONLY_TOOL_NAMES, TOOL_NAMES_BY_CATEGORY } from "../index.mjs"
import { CORE_TOOL_NAMES } from "../core/core-tools.mjs"

/** Every category enabled, so collectCogniaToolDefs emits the full set. */
const ALL_ENABLED = Object.fromEntries(data.categories.map((c) => [c.id, true]))

/** Minimal fakes so the resolver-bound categories (core / lsp) construct. */
const fakeReadTracker = {
  record() {},
  hasRead() {
    return true
  },
  assertReadBefore() {},
  clear() {},
}
const fakeLspResolver = { getDiagnostics: async () => [] }

function collectAll() {
  return collectCogniaToolDefs({
    enabled: ALL_ENABLED,
    readTracker: fakeReadTracker,
    lspResolver: fakeLspResolver,
    dispatchPath: "ai-sdk",
  })
}

/** Flat set of every tool name declared in the metadata JSON. */
const metadataNames = new Set(data.categories.flatMap((c) => c.tools.map((t) => t.name)))

// exit_plan_mode is the ai-sdk-only plan signal tool; it is intentionally NOT a
// metadata category entry (the Anthropic path uses the SDK-native ExitPlanMode).
const NON_METADATA_DEFS = new Set(["exit_plan_mode"])

test("every metadata tool name is actually emitted by collectCogniaToolDefs", () => {
  const emitted = new Set(collectAll().map((t) => t.name))
  for (const name of metadataNames) {
    assert.ok(emitted.has(name), `metadata declares "${name}" but no implementation was collected`)
  }
})

test("every emitted def is either in metadata or a known non-metadata signal tool", () => {
  for (const def of collectAll()) {
    assert.ok(
      metadataNames.has(def.name) || NON_METADATA_DEFS.has(def.name),
      `collected tool "${def.name}" is not declared in builtin-tools-data.json`
    )
  }
})

test("READ_ONLY_TOOL_NAMES is exactly the set of requiresApproval===false tools", () => {
  const expected = new Set(
    data.categories.flatMap((c) =>
      c.tools.filter((t) => t.requiresApproval === false).map((t) => t.name)
    )
  )
  assert.deepEqual([...READ_ONLY_TOOL_NAMES].sort(), [...expected].sort())
})

test("CORE_TOOL_NAMES matches the coreFiles metadata names in order", () => {
  const coreMeta = data.categories.find((c) => c.id === "coreFiles")
  assert.ok(coreMeta, "coreFiles category missing from metadata")
  assert.deepEqual(
    [...CORE_TOOL_NAMES],
    coreMeta.tools.map((t) => t.name)
  )
})

test("TOOL_NAMES_BY_CATEGORY agrees with the metadata per category", () => {
  for (const cat of data.categories) {
    assert.deepEqual(
      TOOL_NAMES_BY_CATEGORY[cat.id],
      cat.tools.map((t) => t.name),
      `category ${cat.id} drifted`
    )
  }
})

test("host-routed tools are NOT declared as sidecar-resident built-ins", () => {
  const hostRouted = [
    "web_search",
    "web_fetch",
    "Skill",
    "SlashCommand",
    "Task",
    "dispatch_agent",
    "ask_user",
  ]
  for (const name of hostRouted) {
    assert.ok(
      !metadataNames.has(name),
      `"${name}" is host-routed and must not appear in builtin-tools-data.json`
    )
  }
})

test("NotebookEdit is registered as an approval-gated coreFiles tool", () => {
  // Locks the Item-2 addition: present, in coreFiles, mutating (needs approval).
  assert.ok(metadataNames.has("NotebookEdit"))
  const coreMeta = data.categories.find((c) => c.id === "coreFiles")
  const entry = coreMeta.tools.find((t) => t.name === "NotebookEdit")
  assert.equal(entry.requiresApproval, true)
  assert.ok(!READ_ONLY_TOOL_NAMES.has("NotebookEdit"))
})

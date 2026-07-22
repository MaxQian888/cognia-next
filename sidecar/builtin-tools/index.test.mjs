import { test } from "node:test"
import assert from "node:assert/strict"

import { collectCogniaToolDefs, buildCogniaToolsServer } from "./index.mjs"

test("collectCogniaToolDefs returns [] for missing / empty enabled", () => {
  assert.deepEqual(collectCogniaToolDefs(), [])
  assert.deepEqual(collectCogniaToolDefs({ enabled: undefined }), [])
  assert.deepEqual(collectCogniaToolDefs({ enabled: {} }), [])
})

test("collectCogniaToolDefs returns well-shaped defs for an enabled category", () => {
  const defs = collectCogniaToolDefs({ enabled: { git: true } })
  assert.ok(defs.length > 0)
  for (const d of defs) {
    assert.equal(typeof d.name, "string")
    assert.equal(typeof d.handler, "function")
  }
})

test("buildCogniaToolsServer returns null when nothing enabled, a server otherwise", () => {
  assert.equal(buildCogniaToolsServer({ enabled: {} }), null)
  assert.ok(buildCogniaToolsServer({ enabled: { git: true } }))
})

const fakeTracker = { record() {}, hasRead: () => false, assertReadBefore() {}, clear() {} }

test("coreFiles suite is included on the ai-sdk path when enabled + tracked", () => {
  const defs = collectCogniaToolDefs({
    enabled: { coreFiles: true },
    readTracker: fakeTracker,
    cwd: ".",
    dispatchPath: "ai-sdk",
  })
  const names = defs.map((d) => d.name)
  // Core suite (fixed order) + the cross-provider exit_plan_mode signal that
  // the ai-sdk path always appends.
  assert.deepEqual(names, [
    "grep",
    "glob",
    "read",
    "ls",
    "edit",
    "multi_edit",
    "write",
    "bash",
    "TodoWrite",
    "bash_output",
    "kill_shell",
    "NotebookEdit",
    "apply_patch",
    "TaskCreate",
    "TaskGet",
    "TaskList",
    "TaskUpdate",
    "list_shells",
    "exit_plan_mode",
  ])
})

test("coreFiles suite is OFF on the anthropic path unless the escape hatch is set", () => {
  const defaultDefs = collectCogniaToolDefs({
    enabled: { coreFiles: true },
    readTracker: fakeTracker,
    cwd: ".",
    dispatchPath: "anthropic",
  })
  assert.equal(defaultDefs.length, 0)

  const hatchDefs = collectCogniaToolDefs({
    enabled: { coreFiles: true, coreFilesOnAnthropic: true },
    readTracker: fakeTracker,
    cwd: ".",
    dispatchPath: "anthropic",
  })
  assert.ok(hatchDefs.some((d) => d.name === "grep"))
})

test("coreFiles suite requires a readTracker", () => {
  const defs = collectCogniaToolDefs({
    enabled: { coreFiles: true },
    cwd: ".",
    dispatchPath: "ai-sdk",
  })
  // Without a readTracker the core file suite is withheld; only the ai-sdk
  // exit_plan_mode signal remains.
  assert.deepEqual(
    defs.map((d) => d.name),
    ["exit_plan_mode"]
  )
})

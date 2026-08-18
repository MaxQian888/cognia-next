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
    "Monitor",
    "monitor_cancel",
    "monitor_list",
    "exit_plan_mode",
  ])
})

test("Anthropic keeps native file tools but still receives the host-backed monitor tools", () => {
  const defaultDefs = collectCogniaToolDefs({
    enabled: { coreFiles: true },
    readTracker: fakeTracker,
    cwd: ".",
    dispatchPath: "anthropic",
  })
  assert.deepEqual(
    defaultDefs.map((definition) => definition.name),
    ["Monitor", "monitor_cancel", "monitor_list"]
  )

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
  // Without a readTracker the file suite is withheld. Host-backed monitor
  // tools do not read files and remain available alongside exit_plan_mode.
  assert.deepEqual(
    defs.map((d) => d.name),
    ["Monitor", "monitor_cancel", "monitor_list", "exit_plan_mode"]
  )
})

// ADR-0045 §3.2 — the plan-authoring pair. Registered on BOTH dispatch paths
// (no provider ships them natively), but only when the caller opts in, so a
// bare "no categories" call still yields nothing.
test("plan tools are opt-in and available on both dispatch paths", () => {
  assert.deepEqual(collectCogniaToolDefs({ enabled: {} }), [])
  assert.deepEqual(
    collectCogniaToolDefs({ enabled: {}, planTools: true }).map((d) => d.name),
    ["create_plan", "update_plan"]
  )
  for (const dispatchPath of ["anthropic", "ai-sdk"]) {
    const names = collectCogniaToolDefs({ enabled: {}, planTools: true, dispatchPath }).map(
      (d) => d.name
    )
    assert.ok(names.includes("create_plan"), dispatchPath)
    assert.ok(names.includes("update_plan"), dispatchPath)
  }
})

test("plan tools acknowledge without side effects (the renderer owns the write)", async () => {
  const [create, update] = collectCogniaToolDefs({ enabled: {}, planTools: true })
  const body = (r) => JSON.parse(r.content[0].text)
  const created = body(
    await create.handler({ title: "Ship", steps: [{ title: "a" }, { title: "b" }] })
  )
  assert.deepEqual(created, { created: true, title: "Ship", steps: 2 })
  const updated = body(await update.handler({ stepUpdates: [{ step: 0, status: "completed" }] }))
  assert.deepEqual(updated, { updated: true, stepUpdates: 1 })
})

import { test } from "node:test"
import assert from "node:assert/strict"

import { collectCogniaToolDefs } from "./registry.ts"
import { findTool, firstJson, firstText } from "../../../test-support/tool-result.ts"
import type { ReadTracker } from "../state/read-tracker.ts"
import type { SessionBgShellRegistry } from "../state/host-background-shells.ts"

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

const fakeTracker: ReadTracker = {
  record() {},
  hasRead: () => false,
  assertReadBefore() {},
  clear() {},
}

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
  for (const dispatchPath of ["anthropic", "ai-sdk"] as const) {
    const names = collectCogniaToolDefs({ enabled: {}, planTools: true, dispatchPath }).map(
      (d) => d.name
    )
    assert.ok(names.includes("create_plan"), dispatchPath)
    assert.ok(names.includes("update_plan"), dispatchPath)
  }
})

test("plan tools acknowledge without side effects (the renderer owns the write)", async () => {
  const defs = collectCogniaToolDefs({ enabled: {}, planTools: true })
  const create = findTool(defs, "create_plan")
  const update = findTool(defs, "update_plan")
  const body = (r: { content: unknown[] }) => firstJson<Record<string, unknown>>(r)
  const created = body(
    await create.handler({ title: "Ship", steps: [{ title: "a" }, { title: "b" }] })
  )
  assert.deepEqual(created, { created: true, title: "Ship", steps: 2 })
  const updated = body(await update.handler({ stepUpdates: [{ step: 0, status: "completed" }] }))
  assert.deepEqual(updated, { updated: true, stepUpdates: 1 })
})

test("collected native process tools all fail closed when the launcher is missing", async () => {
  const definitions = collectCogniaToolDefs({
    enabled: { coreFiles: true, process: true, shellAdvanced: true },
    dispatchPath: "ai-sdk",
    // Any tracker: the calls must be refused before a file is touched.
    readTracker: fakeTracker,
    cwd: process.cwd(),
    builtinProcessSandbox: {
      launcher: "",
      writableRoots: [process.cwd()],
      readableRoots: [],
      network: false,
    },
  })
  const calls: [string, Record<string, unknown>][] = [
    ["bash", { command: "echo hello" }],
    [
      "start_process",
      { program: "git", args: ["status"], detached: false, cwd: process.cwd(), timeoutSecs: 30 },
    ],
    [
      "shell_execute_advanced",
      { command: "git", args: ["status"], cwd: process.cwd(), timeoutMs: 1000 },
    ],
  ]
  for (const [name, input] of calls) {
    const result = await findTool(definitions, name).handler(input)
    assert.equal(result.isError, true, name)
    assert.match(firstText(result), /launcher is unavailable/, name)
  }
})

test("native process jobs expose their existing output and stop controls without core files", () => {
  const tools = collectCogniaToolDefs({
    enabled: { process: true },
    dispatchPath: "anthropic",
    // Presence is all this path checks; no shell is spawned.
    bgShells: {} as SessionBgShellRegistry,
  })
  const names = tools.map((tool) => tool.name)
  for (const name of ["start_process", "bash_output", "kill_shell", "list_shells"])
    assert.ok(names.includes(name), name)
  assert.equal(new Set(names).size, names.length)
})

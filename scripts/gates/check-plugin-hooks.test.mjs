import { test } from "node:test"
import assert from "node:assert/strict"

import { evaluate, hasFireSite, parseContract, runAudit } from "./check-plugin-hooks.mjs"

const CONTRACT_FIXTURE = `
export const CANONICAL_HOOK_POINTS = [
  "onLoad",
  // a comment naming "onGhost" must not be parsed as a hook
  "onScheduledTaskCreate",
] as const

const VIRTUAL_HOOK_POINTS = new Set<CanonicalHookPoint>([
  // "onCommented" is a comment, not an entry
  "onScheduledTaskCreate",
])

export const HOOK_POINT_BINDING = "lib/plugin/messaging/hooks-system.ts"
`

test("parseContract reads hooks, virtual set and binding, ignoring comments", () => {
  const parsed = parseContract(CONTRACT_FIXTURE)
  assert.deepEqual(parsed.hooks, ["onLoad", "onScheduledTaskCreate"])
  assert.deepEqual(parsed.virtual, ["onScheduledTaskCreate"])
  assert.equal(parsed.binding, "lib/plugin/messaging/hooks-system.ts")
})

test("hasFireSite matches whole words only", () => {
  assert.equal(hasFireSite("hooks.onLoad(x)", "onLoad"), true)
  // onLoadExtra must not satisfy onLoad
  assert.equal(hasFireSite("hooks.onLoadExtra(x)", "onLoad"), false)
})

test("green: implemented hook fires, virtual hook does not", () => {
  const report = evaluate({
    hooks: ["onLoad", "onScheduledTaskCreate"],
    virtual: ["onScheduledTaskCreate"],
    bindingSource: "await this.executeHook('onLoad', ...)",
    binding: "hooks-system.ts",
  })
  assert.equal(report.ok, true)
  assert.deepEqual(report.errors, [])
  assert.equal(report.total, 2)
  assert.equal(report.virtual, 1)
})

test("red: a hook contracted as implemented that nothing fires", () => {
  const report = evaluate({
    hooks: ["onLoad"],
    virtual: [],
    bindingSource: "// nothing here",
    binding: "hooks-system.ts",
  })
  assert.equal(report.ok, false)
  assert.equal(report.errors.length, 1)
  assert.match(report.errors[0], /\[implemented-never-fired\]/)
  assert.match(report.errors[0], /onLoad/)
})

test("red: a hook still marked virtual after it was wired up", () => {
  const report = evaluate({
    hooks: ["onScheduledTaskCreate"],
    virtual: ["onScheduledTaskCreate"],
    bindingSource: "await this.executeHook('onScheduledTaskCreate', ...)",
    binding: "hooks-system.ts",
  })
  assert.equal(report.ok, false)
  assert.equal(report.errors.length, 1)
  assert.match(report.errors[0], /\[virtual-but-fired\]/)
})

test("red: VIRTUAL_HOOK_POINTS naming a hook that is not canonical", () => {
  const report = evaluate({
    hooks: ["onLoad"],
    virtual: ["onTypoed"],
    bindingSource: "hooks.onLoad()",
    binding: "hooks-system.ts",
  })
  assert.equal(report.ok, false)
  assert.match(report.errors[0], /\[virtual-unknown\]/)
})

test("the real repo passes, and the virtual set is not empty", () => {
  const report = runAudit()
  assert.equal(report.ok, true, report.errors.join("\n"))
  assert.ok(report.total > 100, `expected the full hook catalog, saw ${report.total}`)
  // Guards the gate against being trivially satisfied by an empty virtual set:
  // the ten dormant hooks this gate was written for must still be labelled.
  assert.ok(report.virtual > 0)
})

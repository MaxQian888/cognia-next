import assert from "node:assert/strict"
import test from "node:test"

import { classifyPlanMode, PLAN_ALLOWED_PLUGIN_TOOLS } from "./plan-mode-policy.mjs"

const options = {
  builtinServerName: "cognia-tools",
  pluginServerName: "cognia-plugin-tools",
  readOnlyBuiltins: new Set(["read"]),
}

test("plan mode permits both scoped Skill loaders in bare and namespaced form", () => {
  for (const name of ["load_skill", "load_skill_resource"]) {
    assert.equal(PLAN_ALLOWED_PLUGIN_TOOLS.has(name), true)
    assert.equal(classifyPlanMode(`mcp__cognia-plugin-tools__${name}`, options), "allow")
  }
})

test("plan mode continues to deny mutating plugin tools", () => {
  assert.equal(classifyPlanMode("mcp__cognia-plugin-tools__artifact_create", options), "deny")
})

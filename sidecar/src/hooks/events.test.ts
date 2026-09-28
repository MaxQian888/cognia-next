import { test } from "node:test"
import assert from "node:assert/strict"
import { SUPPORTED_EVENTS, hookMatchTarget } from "./agent-hooks.ts"

test("the event list comes from the SDK, so it cannot drift", async () => {
  const sdk = await import("@anthropic-ai/claude-agent-sdk")
  assert.deepEqual([...SUPPORTED_EVENTS], [...sdk.HOOK_EVENTS])
})

test("hookMatchTarget reads each event's own discriminator", () => {
  assert.equal(hookMatchTarget("PreToolUse", { tool_name: "Bash" }), "Bash")
  assert.equal(hookMatchTarget("SessionStart", { source: "resume" }), "resume")
  assert.equal(hookMatchTarget("PreCompact", { trigger: "auto" }), "auto")
  assert.equal(hookMatchTarget("FileChanged", { file_path: "/w/a.ts" }), "/w/a.ts")
  assert.equal(hookMatchTarget("Notification", { notification_type: "idle" }), "idle")
  // A tool matcher must not accidentally read a non-tool event's fields.
  assert.equal(hookMatchTarget("SessionStart", { tool_name: "Bash" }), "")
})

test("an event without matcher support ignores configured matchers", () => {
  // Claude Code ignores matcher configuration for these lifecycle events.
  // Returning null tells runGroups to execute the group unconditionally.
  assert.equal(hookMatchTarget("Stop", { tool_name: "Bash" }), null)
})

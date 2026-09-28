import type { HookDecision } from "./kernel/types.ts"
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  extractDecision,
  hookMatchTarget,
  mapDecisionToOutput,
  mergeOutcome,
  parseZeroExitOutput,
} from "./agent-hooks.ts"

test("latest SDK structured hook outputs survive the Cognia translator", () => {
  const cases = {
    PermissionRequest: { decision: { behavior: "deny", message: "Refused", interrupt: true } },
    SessionStart: { watchPaths: ["/workspace"], reloadSkills: true, sessionTitle: "Title" },
    WorktreeCreate: { worktreePath: "/workspace/tree" },
    Elicitation: { action: "decline", content: { answer: "no" } },
    PermissionDenied: { retry: true },
    MessageDisplay: { displayContent: "Replacement" },
    PreModelSwitch: { permissionDecision: "deny", permissionDecisionReason: "Policy" },
    PreToolUse: { permissionDecision: "allow", permissionDecisionReason: "Policy" },
    PostToolUse: { classifierContext: "User confirmed", updatedToolOutput: "safe" },
  }
  for (const [event, fields] of Object.entries(cases)) {
    const expected = { hookSpecificOutput: { hookEventName: event, ...fields } }
    assert.deepEqual(mapDecisionToOutput(event, extractDecision(expected)), expected, event)
  }
  const output = {
    continue: false,
    suppressOutput: true,
    stopReason: "Stop",
    systemMessage: "Info",
    terminalSequence: "\u0007",
  }
  assert.deepEqual(mapDecisionToOutput("Stop", extractDecision(output)), output)
})

test("structured hook merges retain stop precedence and reject mismatched events", () => {
  const decision: HookDecision = { warnings: [] }
  mergeOutcome(
    decision,
    extractDecision({
      continue: false,
      hookSpecificOutput: { hookEventName: "SessionStart", watchPaths: ["/a"] },
    })
  )
  mergeOutcome(
    decision,
    extractDecision({
      continue: true,
      hookSpecificOutput: { hookEventName: "SessionStart", reloadSkills: true },
    })
  )
  assert.deepEqual(mapDecisionToOutput("SessionStart", decision), {
    continue: false,
    hookSpecificOutput: { hookEventName: "SessionStart", watchPaths: ["/a"], reloadSkills: true },
  })
  assert.equal(
    mapDecisionToOutput("PreToolUse", decision).hookSpecificOutput!.permissionDecision,
    "deny"
  )
  assert.deepEqual(mapDecisionToOutput("PermissionRequest", { block: "Policy" }), {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "Policy" },
    },
  })
})

test("hook output pairing preserves explicit values and invalidates superseded assertions", () => {
  const decision: HookDecision = { warnings: [] }
  mergeOutcome(
    decision,
    extractDecision({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: "first",
        classifierContext: "User confirmed first",
      },
    })
  )
  mergeOutcome(
    decision,
    extractDecision({
      hookSpecificOutput: { hookEventName: "PostToolUse", updatedMCPToolOutput: "second" },
    })
  )
  assert.equal(
    mapDecisionToOutput("PostToolUse", decision).hookSpecificOutput!.classifierContext,
    undefined
  )
  assert.equal(
    mapDecisionToOutput("PostToolUse", decision).hookSpecificOutput!.updatedToolOutput,
    "second"
  )
  assert.deepEqual(
    mapDecisionToOutput("Stop", extractDecision({ decision: "approve", reason: "Ready" })),
    { decision: "approve", reason: "Ready" }
  )
  assert.equal(
    mapDecisionToOutput(
      "PermissionRequest",
      extractDecision({
        hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny" } },
      })
    ).hookSpecificOutput!.decision!.behavior,
    "deny"
  )
  assert.deepEqual(
    mapDecisionToOutput("WorktreeCreate", parseZeroExitOutput("/workspace/tree\n")),
    { hookSpecificOutput: { hookEventName: "WorktreeCreate", worktreePath: "/workspace/tree" } }
  )
  assert.deepEqual(extractDecision(null), {})
  assert.equal(hookMatchTarget("unknown", {}), null)
  const legacyRewrite = { warnings: [] }
  mergeOutcome(
    legacyRewrite,
    extractDecision({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: "first",
        classifierContext: "First assertion",
      },
    })
  )
  mergeOutcome(legacyRewrite, { updatedToolOutput: "replacement" })
  assert.equal(
    mapDecisionToOutput("PostToolUse", legacyRewrite).hookSpecificOutput!.classifierContext,
    undefined
  )
  const unbound = { warnings: [] }
  mergeOutcome(
    unbound,
    extractDecision({
      hookSpecificOutput: { hookEventName: "PostToolUse", classifierContext: "User confirmed" },
    })
  )
  mergeOutcome(
    unbound,
    extractDecision({
      hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: null },
    })
  )
  assert.deepEqual(mapDecisionToOutput("PostToolUse", unbound), {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      classifierContext: "User confirmed",
      updatedToolOutput: null,
    },
  })
})

test("mapDecisionToOutput: PreToolUse deny / rewrite / ask / context / noop", () => {
  assert.deepEqual(mapDecisionToOutput("PreToolUse", { block: "no", warnings: [] }), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "no",
    },
  })
  assert.deepEqual(
    mapDecisionToOutput("PreToolUse", { updatedInput: { command: "ls" }, warnings: [] }),
    {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: "ls" },
      },
    }
  )
  assert.equal(
    mapDecisionToOutput("PreToolUse", { permissionDecision: "ask", warnings: [] })
      .hookSpecificOutput!.permissionDecision,
    "ask"
  )
  assert.equal(
    mapDecisionToOutput("PreToolUse", { additionalContext: "c", warnings: [] }).hookSpecificOutput!
      .additionalContext,
    "c"
  )
  assert.deepEqual(mapDecisionToOutput("PreToolUse", { warnings: ["w"] }), {})
})

test("mapDecisionToOutput: PostToolUse output rewrite + block", () => {
  assert.deepEqual(
    mapDecisionToOutput("PostToolUse", { updatedToolOutput: "patched", warnings: [] }),
    { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "patched" } }
  )
  assert.deepEqual(mapDecisionToOutput("PostToolUse", { block: "bad", warnings: [] }), {
    decision: "block",
    reason: "bad",
  })
  assert.equal(
    mapDecisionToOutput("PostToolUseFailure", { additionalContext: "c", warnings: [] })
      .hookSpecificOutput!.hookEventName,
    "PostToolUseFailure"
  )
})

test("mapDecisionToOutput: generic lifecycle block + context", () => {
  assert.deepEqual(mapDecisionToOutput("Stop", { block: "keep going", warnings: [] }), {
    decision: "block",
    reason: "keep going",
  })
  assert.equal(
    mapDecisionToOutput("SessionStart", { additionalContext: "ctx", warnings: [] })
      .hookSpecificOutput!.additionalContext,
    "ctx"
  )
})

test("a lifecycle event blocks and injects context through the generic mapping", () => {
  for (const event of ["UserPromptSubmit", "SessionStart", "Stop", "TaskCreated"]) {
    assert.deepEqual(mapDecisionToOutput(event, { block: "no" }), {
      decision: "block",
      reason: "no",
    })
    assert.deepEqual(mapDecisionToOutput(event, { additionalContext: "ctx" }), {
      hookSpecificOutput: { hookEventName: event, additionalContext: "ctx" },
    })
    assert.deepEqual(mapDecisionToOutput(event, {}), {})
  }
})

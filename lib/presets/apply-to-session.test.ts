import {
  buildAutoApplySessionPatch,
  buildPresetApplicationPlan,
  detectPresetConflicts,
} from "./apply-to-session"
import type { ChatSession, SystemPromptPreset } from "@cognia/agent-config-types"

function makePreset(over: Partial<SystemPromptPreset> = {}): SystemPromptPreset {
  return {
    id: "p_1",
    name: "Test",
    content: "You are a test bot.",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function makeSession(
  over: Partial<Pick<ChatSession, "systemPrompt" | "model" | "permissionMode" | "workingDir">> = {}
): Pick<ChatSession, "systemPrompt" | "model" | "permissionMode" | "workingDir"> {
  return {
    systemPrompt: undefined,
    model: undefined,
    permissionMode: undefined,
    workingDir: undefined,
    ...over,
  }
}

describe("detectPresetConflicts", () => {
  it("returns empty when session has no values", () => {
    expect(detectPresetConflicts(makePreset({ model: "claude-x" }), makeSession())).toEqual([])
  })

  it("flags every field where preset and session both have values", () => {
    const conflicts = detectPresetConflicts(
      makePreset({ model: "claude-x", workingDir: "/src", permissionMode: "plan" }),
      makeSession({
        systemPrompt: "existing",
        model: "claude-y",
        workingDir: "/elsewhere",
        permissionMode: "default",
      })
    )
    expect(conflicts.sort()).toEqual(
      ["model", "permissionMode", "systemPrompt", "workingDir"].sort()
    )
  })

  it("treats whitespace-only strings as empty", () => {
    expect(
      detectPresetConflicts(makePreset({ workingDir: "/src" }), makeSession({ workingDir: "   " }))
    ).toEqual([])
  })
})

describe("buildPresetApplicationPlan — overwrite-all", () => {
  it("forces every preset value into the patch even when session is non-empty", () => {
    const plan = buildPresetApplicationPlan(
      makePreset({ model: "claude-x", permissionMode: "plan", workingDir: "/src" }),
      makeSession({
        systemPrompt: "existing",
        model: "claude-y",
        permissionMode: "default",
        workingDir: "/elsewhere",
      }),
      "overwrite-all"
    )
    expect(plan.sessionPatch.systemPrompt).toBe("You are a test bot.")
    expect(plan.sessionPatch.model).toBe("claude-x")
    expect(plan.sessionPatch.permissionMode).toBe("plan")
    expect(plan.sessionPatch.workingDir).toBe("/src")
    expect(plan.preserved).toEqual([])
    expect(plan.conflicts).toContain("systemPrompt")
  })

  it("includes effort + extended array fields", () => {
    const plan = buildPresetApplicationPlan(
      makePreset({
        effort: "high",
        allowedTools: ["Bash"],
        mcpServerIds: ["m1"],
        skillIds: ["s1"],
        agentModeId: "code-gen",
      }),
      makeSession(),
      "overwrite-all"
    )
    expect(plan.extended.effort).toBe("high")
    expect(plan.extended.allowedTools).toEqual(["Bash"])
    expect(plan.extended.mcpServerIds).toEqual(["m1"])
    expect(plan.extended.skillIds).toEqual(["s1"])
    expect(plan.extended.agentModeId).toBe("code-gen")
  })
})

describe("buildPresetApplicationPlan — fill-empty", () => {
  it("only writes fields the session left empty", () => {
    const plan = buildPresetApplicationPlan(
      makePreset({ model: "claude-x", workingDir: "/src" }),
      makeSession({ model: "claude-y" }),
      "fill-empty"
    )
    expect(plan.sessionPatch.systemPrompt).toBe("You are a test bot.")
    expect(plan.sessionPatch.model).toBeUndefined()
    expect(plan.sessionPatch.workingDir).toBe("/src")
    expect(plan.preserved).toContain("model")
    expect(plan.conflicts).toContain("model")
  })

  it("array fields fall back to fill-empty under the same strategy", () => {
    const plan = buildPresetApplicationPlan(
      makePreset({ allowedTools: ["Bash", "Read"] }),
      makeSession(),
      "fill-empty",
      { sessionAllowedTools: ["Read"] }
    )
    // Session non-empty → array preserved
    expect(plan.extended.allowedTools).toBeUndefined()
    expect(plan.preserved).toContain("allowedTools")
  })

  it("array fields fill into empty session arrays", () => {
    const plan = buildPresetApplicationPlan(
      makePreset({ allowedTools: ["Bash"] }),
      makeSession(),
      "fill-empty"
    )
    expect(plan.extended.allowedTools).toEqual(["Bash"])
  })
})

describe("buildPresetApplicationPlan — merge", () => {
  it("unions array fields without duplicates", () => {
    const plan = buildPresetApplicationPlan(
      makePreset({ allowedTools: ["Bash", "Read"] }),
      makeSession(),
      "merge",
      { sessionAllowedTools: ["Read", "WebSearch"] }
    )
    expect(plan.extended.allowedTools?.sort()).toEqual(["Bash", "Read", "WebSearch"].sort())
    expect(plan.conflicts).toContain("allowedTools")
  })

  it("scalar conflicts behave like fill-empty", () => {
    const plan = buildPresetApplicationPlan(
      makePreset({ model: "claude-x" }),
      makeSession({ model: "claude-y" }),
      "merge"
    )
    expect(plan.sessionPatch.model).toBeUndefined()
    expect(plan.preserved).toContain("model")
  })
})

describe("buildAutoApplySessionPatch", () => {
  it("only fills fields not provided by partial", () => {
    const patch = buildAutoApplySessionPatch(
      makePreset({ model: "claude-x", workingDir: "/src" }),
      { model: "claude-y" } as Partial<ChatSession>
    )
    expect(patch.systemPrompt).toBe("You are a test bot.")
    expect(patch.workingDir).toBe("/src")
    expect(patch.model).toBeUndefined()
  })

  it("returns empty when preset has no payload", () => {
    const patch = buildAutoApplySessionPatch(makePreset({ content: "" }), {
      model: "claude-y",
    } as Partial<ChatSession>)
    expect(patch).toEqual({})
  })
})

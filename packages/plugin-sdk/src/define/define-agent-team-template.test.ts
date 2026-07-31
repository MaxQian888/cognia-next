/**
 * `defineAgentTeamTemplate` is a pure identity function whose only job is
 * compile-time type narrowing for plugin authors. The runtime guarantee is
 * "what you put in is what you get out, by reference" — the test below pins
 * that contract so future refactors can't accidentally introduce a clone or
 * default-fill.
 */

import { defineAgentTeamTemplate } from "./define-agent-team-template"
import type { PluginAgentTeamTemplateDef } from "@/types/plugin/plugin-agent-team-template"

describe("defineAgentTeamTemplate", () => {
  it("returns the same object reference passed in", () => {
    const def: PluginAgentTeamTemplateDef = {
      id: "pr-review",
      name: "PR Review",
      description: "Multi-reviewer PR walkthrough",
      category: "review",
      teammates: [
        { name: "Security", description: "Reviews security" },
        { name: "Performance", description: "Reviews perf" },
      ],
    }

    const result = defineAgentTeamTemplate(def)

    expect(result).toBe(def)
  })

  it("preserves the requires block including all id arrays", () => {
    const def: PluginAgentTeamTemplateDef = {
      id: "with-requires",
      name: "With requires",
      description: "Has cross-capability deps",
      category: "development",
      teammates: [{ name: "T1", description: "" }],
      requires: {
        mcpServerPresetIds: ["a", "b"],
        skillIds: ["s"],
        characterPackIds: ["c"],
        nativeAnthropicToolIds: ["computer_20251124"],
        externalAgentPresetIds: ["claude-code"],
        subagentIds: ["my-plugin:reviewer", "workflow-designer"],
      },
    }

    expect(defineAgentTeamTemplate(def).requires).toEqual({
      mcpServerPresetIds: ["a", "b"],
      skillIds: ["s"],
      characterPackIds: ["c"],
      nativeAnthropicToolIds: ["computer_20251124"],
      externalAgentPresetIds: ["claude-code"],
      subagentIds: ["my-plugin:reviewer", "workflow-designer"],
    })
  })

  it("preserves taskTemplates and config overrides", () => {
    const def: PluginAgentTeamTemplateDef = {
      id: "task-and-config",
      name: "Tasks + config",
      description: "",
      category: "general",
      teammates: [{ name: "T", description: "" }],
      taskTemplates: [
        { title: "task 1", description: "desc", priority: "normal", assignedToIndex: 0 },
      ],
      config: { executionMode: "autonomous", requirePlanApproval: true },
      icon: "Wrench",
    }

    const out = defineAgentTeamTemplate(def)
    expect(out.taskTemplates).toHaveLength(1)
    expect(out.config).toEqual({ executionMode: "autonomous", requirePlanApproval: true })
    expect(out.icon).toBe("Wrench")
  })
})

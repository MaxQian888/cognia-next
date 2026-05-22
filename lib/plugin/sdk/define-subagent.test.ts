/**
 * `defineSubagent` is a pure identity function whose only job is compile-time
 * type narrowing for plugin authors. The runtime guarantee is "what you put
 * in is what you get out, by reference" — the test below pins that contract
 * so future refactors can't accidentally introduce a clone or default-fill.
 */

import { defineSubagent } from "./define-subagent"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"

describe("defineSubagent", () => {
  it("returns the same object reference passed in", () => {
    const def: PluginSubagentDef = {
      id: "code-reviewer",
      name: "Code Reviewer",
      description: "Reviews code changes",
      prompt: "You are a code reviewer.",
    }

    const result = defineSubagent(def)

    expect(result).toBe(def)
  })

  it("preserves every optional field on the def", () => {
    const def: PluginSubagentDef = {
      id: "with-everything",
      name: "All fields",
      description: "All fields populated",
      prompt: "system prompt",
      tools: ["Read", "Grep"],
      disallowedTools: ["Bash"],
      model: "sonnet",
      maxTurns: 8,
      effort: "high",
    }

    expect(defineSubagent(def)).toMatchObject({
      tools: ["Read", "Grep"],
      disallowedTools: ["Bash"],
      model: "sonnet",
      maxTurns: 8,
      effort: "high",
    })
  })
})

/** `defineSubagent` preserves string-only defs and resolves typed tool refs. */

import { defineSubagent } from "./define-subagent"
import { defineTool } from "./define-tool"
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

  it("accepts typed tool definitions and projects them to runtime names", () => {
    const queryLogs = defineTool({
      name: "query_logs",
      description: "Query operational logs",
      parametersSchema: { type: "object", properties: {} },
    })

    expect(
      defineSubagent({
        id: "diagnostician",
        name: "Diagnostician",
        description: "Diagnoses incidents",
        prompt: "Inspect the incident.",
        tools: [queryLogs, "Read"],
      }).tools
    ).toEqual(["query_logs", "Read"])
  })
})

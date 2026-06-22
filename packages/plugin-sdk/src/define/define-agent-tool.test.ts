/**
 * `defineAgentTool` is a pure identity function for compile-time type
 * narrowing. The runtime contract is "what you put in is what you get out, by
 * reference" — pinned below so a future refactor can't introduce a clone.
 */

import { defineAgentTool } from "./define-agent-tool"
import type { PluginAgentToolInput } from "@/types/plugin/plugin-agent-sdk"

describe("defineAgentTool", () => {
  it("returns the same object reference passed in", () => {
    const tool: PluginAgentToolInput = {
      name: "web_fetch",
      execute: async () => "ok",
    }
    expect(defineAgentTool(tool)).toBe(tool)
  })

  it("preserves every optional field on the tool", () => {
    const gate = async () => ({ behavior: "allow" as const })
    const tool: PluginAgentToolInput = {
      name: "full",
      description: "desc",
      parameters: { type: "object" },
      schema: { type: "object" },
      execute: async () => null,
      canUseTool: gate,
    }
    expect(defineAgentTool(tool)).toMatchObject({
      description: "desc",
      parameters: { type: "object" },
      schema: { type: "object" },
      canUseTool: gate,
    })
  })
})

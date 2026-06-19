import { defineExternalAgentPreset } from "./define-external-agent-preset"

describe("defineExternalAgentPreset", () => {
  it("returns the preset definition unchanged (pure pass-through)", () => {
    const def = defineExternalAgentPreset({
      id: "claude-code",
      name: "Claude Code",
      description: "Claude Code external agent",
      protocol: "acp",
      transport: "stdio",
      process: { command: "claude", args: ["--acp"] },
      defaultPermissionMode: "default",
      tags: [],
    })
    expect(def).toMatchObject({ id: "claude-code", name: "Claude Code" })
    expect(def.process).toEqual({ command: "claude", args: ["--acp"] })
  })
})

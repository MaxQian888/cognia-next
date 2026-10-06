/** @jest-environment node */
import type { AgentHookContext } from "@/lib/ai/agent/external/agent-hooks"
import { cliAgentHookPlane } from "./hook-plane"

const ctx = {
  agentId: "a",
  sessionId: "s",
  agentKind: "external",
  agentRef: "external-agent:a",
} satisfies AgentHookContext

describe("CLI external-agent hook plane", () => {
  it("runs no settings hook and loads no plugin event hooks", async () => {
    await expect(cliAgentHookPlane.run("PreToolUse", ctx, { toolName: "bash" })).resolves.toBeNull()
    await expect(cliAgentHookPlane.run("Stop", ctx)).resolves.toBeNull()
    expect(cliAgentHookPlane.pluginHooks).toBeNull()
    expect(Object.isFrozen(cliAgentHookPlane)).toBe(true)
  })
})

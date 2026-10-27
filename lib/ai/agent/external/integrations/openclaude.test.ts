import type { AgentProcessHost } from "@cognia/agent-contracts/host"
import { OpenClaudeAdapter } from "@cognia/agent-openclaude/client"
import { createOpenClaudeAdapter, createOpenClaudeAdapterFactory } from "./openclaude"

function processHost(): jest.Mocked<AgentProcessHost> {
  return {
    available: true,
    spawn: jest.fn(),
    send: jest.fn(),
    kill: jest.fn(),
    commandExists: jest.fn(async (_command: string) => false),
    onStdoutLine: jest.fn(),
    onStdoutRaw: jest.fn(),
    onStderr: jest.fn(),
    onExit: jest.fn(),
  }
}

it("wires an independent OpenClaude adapter to the app process and privacy ports", async () => {
  const host = processHost()
  const adapter = createOpenClaudeAdapter(host)
  expect(adapter).toBeInstanceOf(OpenClaudeAdapter)
  expect(adapter.protocol).toBe("openclaude-cli")
  await expect(
    adapter.connect({
      id: "oc",
      name: "OpenClaude",
      protocol: "openclaude-cli",
      transport: "stdio",
      process: { command: "openclaude", args: [], cwd: "/workspace" },
    } as never)
  ).rejects.toThrow()
  expect(host.commandExists).toHaveBeenCalledWith("openclaude")
  expect(host.spawn).not.toHaveBeenCalled()
  const factory = createOpenClaudeAdapterFactory(host)
  expect(factory()).not.toBe(factory())
})

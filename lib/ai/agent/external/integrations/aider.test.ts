import type { AgentFileHost, AgentProcessHost } from "@cognia/agent-contracts/host"
import { AiderCliClientAdapter } from "@cognia/agent-aider/cli-client"
import { AIDER_CLI_EXECUTION_SEMANTICS } from "@cognia/agent-aider/manifest"
import { createAiderCliAdapter, createAiderCliAdapterFactory } from "./aider"

function processHost(): jest.Mocked<AgentProcessHost> {
  return {
    available: true,
    spawn: jest.fn(),
    send: jest.fn(),
    kill: jest.fn(),
    commandExists: jest.fn(async (_command: string) => true),
    onStdoutLine: jest.fn(),
    onStdoutRaw: jest.fn(),
    onStderr: jest.fn(),
    onExit: jest.fn(),
  }
}

function fileHost(files = new Map<string, string>()): AgentFileHost {
  return {
    available: true,
    isWithinRoot: (path, root) => path.startsWith(`${root}/`),
    readText: async (path) => files.get(path) ?? "",
    writeText: async (path, content) => {
      files.set(path, content)
    },
    delete: async (path) => {
      files.delete(path)
    },
  }
}

const config = {
  id: "aider",
  name: "Aider",
  protocol: "aider-cli",
  transport: "stdio",
  process: { command: "aider", args: [], cwd: "/workspace" },
} as never

describe("Aider host wiring", () => {
  it("builds the aider-cli adapter with per-turn semantics", () => {
    const adapter = createAiderCliAdapterFactory(processHost(), fileHost())()
    expect(adapter).toBeInstanceOf(AiderCliClientAdapter)
    expect(adapter.protocol).toBe("aider-cli")
    expect(adapter.semantics).toBe(AIDER_CLI_EXECUTION_SEMANTICS)
  })

  it("probes the CLI through the process host it was built with", async () => {
    const host = processHost()
    host.commandExists.mockResolvedValueOnce(false)
    await expect(createAiderCliAdapterFactory(host, fileHost())().connect(config)).rejects.toThrow(
      /not installed/
    )
    expect(host.commandExists).toHaveBeenCalledWith("aider")
  })

  it("applies the app's PII gate to session instructions", async () => {
    const adapter = createAiderCliAdapterFactory(processHost(), fileHost())()
    await adapter.connect(config)
    await expect(
      adapter.createSession({ systemPrompt: "Write to alice@example.com" })
    ).rejects.toThrow(/PII gate/)
  })

  it("exposes the concrete adapter for hosts that drive it directly", () => {
    expect(createAiderCliAdapter(processHost(), fileHost())).toBeInstanceOf(AiderCliClientAdapter)
  })

  it("creates an independent adapter per configuration", () => {
    const factory = createAiderCliAdapterFactory(processHost(), fileHost())
    expect(factory()).not.toBe(factory())
  })
})

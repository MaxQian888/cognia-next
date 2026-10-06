const mockAgentInvoke = jest.fn()
jest.mock("../agent-transport", () => ({
  agentInvoke: (...args: unknown[]) => mockAgentInvoke(...args),
  agentListen: jest.fn(async () => () => {}),
  runsExternalAgentProcessesLocally: () => mockLocal,
  supportsExternalAgents: () => true,
}))
const mockReadSecrets = jest.fn()
jest.mock("../lifecycle/service", () => ({
  getExternalAgentLifecycleService: async () => ({ readSecrets: mockReadSecrets }),
}))
let mockLocal = true

import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import type { AgentProcessHost } from "@cognia/agent-contracts/host"
import { DshSdkClientAdapter } from "@cognia/agent-dsh/sdk-client"
import { DSH_SDK_EXECUTION_SEMANTICS } from "@cognia/agent-dsh/manifest"
import { createDshSdkAdapterFactory, dshManagedLaunchHost } from "./dsh"

const config = { id: "dsh", name: "DSH", protocol: "dsh-sdk" } as ExternalAgentConfig

describe("DeepSeek Harness host wiring", () => {
  beforeEach(() => {
    mockAgentInvoke.mockReset()
    mockReadSecrets.mockReset()
    mockLocal = true
  })

  it("builds the dsh-sdk adapter with its declared process-scoped cancel", () => {
    const adapter = createDshSdkAdapterFactory()()
    expect(adapter).toBeInstanceOf(DshSdkClientAdapter)
    expect(adapter.protocol).toBe("dsh-sdk")
    expect(adapter.semantics).toBe(DSH_SDK_EXECUTION_SEMANTICS)
  })

  it("hands the adapter's transports the process host it was built with", async () => {
    const host: AgentProcessHost = {
      available: false,
      spawn: jest.fn(),
      send: jest.fn(),
      kill: jest.fn(),
      commandExists: jest.fn(),
      onStdoutLine: jest.fn(),
      onStdoutRaw: jest.fn(),
      onStderr: jest.fn(),
      onExit: jest.fn(),
    }
    const adapter = createDshSdkAdapterFactory(host)()
    await expect(adapter.connect({ ...config, process: { command: "node" } })).rejects.toThrow(
      /process host/
    )
    expect(host.spawn).not.toHaveBeenCalled()
  })

  it("defaults to the local process host so a paired browser is not offered DSH", async () => {
    mockLocal = false
    const adapter = createDshSdkAdapterFactory()()
    await expect(adapter.connect({ ...config, process: { command: "node" } })).rejects.toThrow(
      /process host/
    )
    expect(mockAgentInvoke).not.toHaveBeenCalled()
  })

  it("gates personas and prompts with the app's PII gate", () => {
    expect(dshManagedLaunchHost.outboundGate("plain persona")).toBe(true)
    expect(dshManagedLaunchHost.outboundGate("mail alice@example.com")).toBe(false)
  })

  it("reads installed-runtime facts through the host command", async () => {
    mockAgentInvoke.mockResolvedValue({ runtimeHome: "/rt" })
    await expect(dshManagedLaunchHost.readRuntimeFacts()).resolves.toEqual({ runtimeHome: "/rt" })
    expect(mockAgentInvoke).toHaveBeenCalledWith("dsh_runtime_facts", {})
  })

  it("reads only the configuration's own DeepSeek key from its keyring entries", async () => {
    mockReadSecrets.mockResolvedValue({ processEnv: { DEEPSEEK_API_KEY: "own-key", OTHER: "x" } })
    await expect(dshManagedLaunchHost.readApiKey(config)).resolves.toBe("own-key")
    expect(mockReadSecrets).toHaveBeenCalledWith(config)
    mockReadSecrets.mockResolvedValue({})
    await expect(dshManagedLaunchHost.readApiKey(config)).resolves.toBeUndefined()
  })
})

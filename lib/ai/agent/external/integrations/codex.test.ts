const mockBuildAgentEnv = jest.fn(async () => ({ CODEX_ACCESS_TOKEN: "tok" }))
jest.mock("../config/env-builder", () => ({
  buildAgentEnv: (...args: unknown[]) => mockBuildAgentEnv(...(args as [])),
}))
const mockRecord = jest.fn(async () => {})
jest.mock("@/lib/task-workspace/tool-evidence", () => ({
  recordToolFileChanges: (...args: unknown[]) => mockRecord(...(args as [])),
}))

import type { AgentProcessHost } from "@cognia/agent-contracts/host"
import {
  CodexAppServerAdapter,
  codexAppServerExtension,
} from "@cognia/agent-codex/app-server-client"
import { CODEX_APP_SERVER_EXECUTION_SEMANTICS } from "@cognia/agent-codex/manifest"
import { createCodexAppServerAdapterFactory } from "./codex"

function unavailableHost(): AgentProcessHost {
  return {
    available: false,
    spawn: jest.fn(),
    send: jest.fn(),
    kill: jest.fn(),
    onStdoutLine: jest.fn(),
    onStdoutRaw: jest.fn(),
    onStderr: jest.fn(),
    onExit: jest.fn(),
  }
}

describe("Codex host wiring", () => {
  it("builds the codex-app-server adapter with turn-scoped cancel semantics", () => {
    const adapter = createCodexAppServerAdapterFactory(unavailableHost())()
    expect(adapter).toBeInstanceOf(CodexAppServerAdapter)
    expect(adapter.protocol).toBe("codex-app-server")
    expect(adapter.semantics).toBe(CODEX_APP_SERVER_EXECUTION_SEMANTICS)
    expect(codexAppServerExtension.resolve(adapter)).toBe(adapter)
  })

  it("refuses to connect without a process host and never resolves credentials", async () => {
    const host = unavailableHost()
    const adapter = createCodexAppServerAdapterFactory(host)()
    await expect(
      adapter.connect({
        id: "codex",
        name: "Codex",
        protocol: "codex-app-server",
        transport: "stdio",
        process: { command: "codex", args: ["app-server"] },
      } as never)
    ).rejects.toThrow(/process host/)
    expect(host.spawn).not.toHaveBeenCalled()
    expect(mockBuildAgentEnv).not.toHaveBeenCalled()
  })

  it("applies the app's PII gate to outbound Codex payloads", async () => {
    const send = jest.fn()
    const host: AgentProcessHost = { ...unavailableHost(), available: true, send }
    const adapter = createCodexAppServerAdapterFactory(host)() as unknown as {
      processId?: string
      writeToProcess(message: string): Promise<void>
    }
    adapter.processId = "codex"
    await expect(
      adapter.writeToProcess(
        JSON.stringify({ method: "turn/start", text: "mail alice@example.com" })
      )
    ).rejects.toThrow(/PII gate/)
    expect(send).not.toHaveBeenCalled()
  })

  it("creates an independent adapter per configuration", () => {
    const factory = createCodexAppServerAdapterFactory(unavailableHost())
    expect(factory()).not.toBe(factory())
  })
})

/** @jest-environment node */
const invokeMock = jest.fn()
const listenMock = jest.fn()

jest.mock("./host-branch", () => ({
  agentInvoke: (...args: unknown[]) => invokeMock(...args),
  agentListen: (...args: unknown[]) => listenMock(...args),
}))

import {
  acpTerminalCreate,
  checkExternalAgentCommandExists,
  onExternalAgentStdout,
  spawnExternalAgent,
} from "./native-shim"

describe("CLI native external-agent shim", () => {
  it("delegates process commands and raw event payloads to the host branch", async () => {
    invokeMock.mockResolvedValueOnce("a1")
    const config = { id: "a1", command: "codex", args: ["app-server"] }
    await expect(spawnExternalAgent(config)).resolves.toBe("a1")
    expect(invokeMock).toHaveBeenCalledWith("spawn_external_agent", { config })

    invokeMock.mockResolvedValueOnce(true)
    await expect(checkExternalAgentCommandExists("codex")).resolves.toBe(true)
    expect(invokeMock).toHaveBeenCalledWith("check_command_exists", { command: "codex" })

    const handler = jest.fn()
    listenMock.mockResolvedValueOnce(() => undefined)
    await onExternalAgentStdout(handler)
    expect(listenMock).toHaveBeenCalledWith("external-agent://stdout", handler)
  })

  it("fails closed for ACP terminals", async () => {
    await expect(acpTerminalCreate("s1", "bash")).rejects.toThrow(/ACP terminals are unsupported/)
  })
})

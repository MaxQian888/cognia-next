/** @jest-environment node */
const invokeMock = jest.fn()
const listenMock = jest.fn()

jest.mock("./host-branch", () => ({
  agentInvoke: (...args: unknown[]) => invokeMock(...args),
  agentListen: (...args: unknown[]) => listenMock(...args),
}))

import {
  acpTerminalCreate,
  acpTerminalGetSessionTerminals,
  acpTerminalOutput,
  acpTerminalRelease,
  acpTerminalWaitForExit,
  checkExternalAgentCommandExists,
  onExternalAgentStdout,
  spawnExternalAgent,
  truncateTerminalOutputUtf8,
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

  it("retains PTY output and truncates its tail on complete UTF-8 boundaries", async () => {
    if (process.platform === "win32") return

    const terminalId = await acpTerminalCreate(
      "s1",
      "/bin/sh",
      ["-c", "printf '\\344\\275\\240\\345\\245\\275abc'"],
      undefined,
      undefined,
      4
    )
    try {
      await expect(acpTerminalWaitForExit(terminalId, 5)).resolves.toMatchObject({
        exitStatus: { exitCode: 0, signal: null },
      })
      await expect(acpTerminalOutput(terminalId)).resolves.toMatchObject({
        output: "abc",
        truncated: true,
        exitStatus: { exitCode: 0, signal: null },
      })
      await expect(acpTerminalGetSessionTerminals("s1")).resolves.toEqual([terminalId])
    } finally {
      await acpTerminalRelease(terminalId)
    }
    await expect(acpTerminalGetSessionTerminals("s1")).resolves.toEqual([])
  })

  it("validates limits and never returns a partial UTF-8 scalar", () => {
    expect(truncateTerminalOutputUtf8("a你b", 4)).toEqual({ output: "你b", truncated: true })
    expect(truncateTerminalOutputUtf8("你好", 2)).toEqual({ output: "", truncated: true })
    expect(() => truncateTerminalOutputUtf8("x", -1)).toThrow(/non-negative/)
  })
})

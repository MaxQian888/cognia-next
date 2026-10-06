/** @jest-environment node */
import {
  acpTerminalCreate,
  acpTerminalGetInfo,
  acpTerminalGetSessionTerminals,
  acpTerminalIsRunning,
  acpTerminalKill,
  acpTerminalKillSessionTerminals,
  acpTerminalList,
  acpTerminalOutput,
  acpTerminalRelease,
  acpTerminalWaitForExit,
  acpTerminalWrite,
  cliTerminalPlane,
  truncateTerminalOutputUtf8,
} from "./pty-terminals"

describe("CLI PTY terminals", () => {
  it("exposes every ACP terminal command as the installed terminal plane", () => {
    expect(cliTerminalPlane).toEqual({
      create: acpTerminalCreate,
      output: acpTerminalOutput,
      kill: acpTerminalKill,
      release: acpTerminalRelease,
      waitForExit: acpTerminalWaitForExit,
      write: acpTerminalWrite,
      sessionTerminals: acpTerminalGetSessionTerminals,
      killSessionTerminals: acpTerminalKillSessionTerminals,
      isRunning: acpTerminalIsRunning,
      info: acpTerminalGetInfo,
      list: acpTerminalList,
    })
    expect(Object.isFrozen(cliTerminalPlane)).toBe(true)
  })

  it("does not require the Darwin-only spawn helper for a Linux PTY", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { ...platform, value: "linux" })
    const chmod = jest.fn()
    const spawn = jest.fn(() => ({
      onData: jest.fn(() => ({ dispose: jest.fn() })),
      onExit: jest.fn(() => ({ dispose: jest.fn() })),
      kill: jest.fn(),
    }))
    try {
      jest.doMock("node:fs", () => ({ ...jest.requireActual("node:fs"), chmodSync: chmod }))
      jest.doMock("node-pty", () => ({ spawn }))
      await jest.isolateModulesAsync(async () => {
        const terminals = await import("./pty-terminals")
        const id = await terminals.acpTerminalCreate("linux-session", "/bin/sh")
        try {
          expect(spawn).toHaveBeenCalled()
          expect(chmod).not.toHaveBeenCalled()
        } finally {
          await terminals.acpTerminalRelease(id)
        }
      })
    } finally {
      Object.defineProperty(process, "platform", platform)
      jest.dontMock("node:fs")
      jest.dontMock("node-pty")
    }
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

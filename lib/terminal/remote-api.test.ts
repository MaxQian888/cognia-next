jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn(), subscribe: jest.fn() },
}))

import { transport } from "@/lib/tauri"

import { completeTerminalPaths, execTerminalCommand, killTerminalPort } from "./remote-api"

const callMock = transport.call as jest.Mock

beforeEach(() => {
  callMock.mockReset().mockResolvedValue(undefined)
})

describe("terminal remote-api", () => {
  it("execTerminalCommand maps the full request shape", async () => {
    const result = { stdout: "ok", stderr: "", exitCode: 0, timedOut: false }
    callMock.mockResolvedValue(result)
    const out = await execTerminalCommand({
      command: "git",
      args: ["status"],
      cwd: "/repo",
      env: { CI: "1" },
      timeoutMs: 5000,
    })
    expect(callMock).toHaveBeenCalledWith("terminal_exec", {
      command: "git",
      args: ["status"],
      cwd: "/repo",
      env: { CI: "1" },
      timeoutMs: 5000,
      shell: undefined,
    })
    expect(out).toEqual(result)
  })

  it("execTerminalCommand leaves optional fields undefined", async () => {
    callMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false })
    await execTerminalCommand({ command: "ls" })
    expect(callMock).toHaveBeenCalledWith("terminal_exec", {
      command: "ls",
      args: undefined,
      cwd: undefined,
      env: undefined,
      timeoutMs: undefined,
      shell: undefined,
    })
  })

  it("execTerminalCommand passes shell mode for full command lines", async () => {
    callMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false })
    await execTerminalCommand({ command: "echo a && echo b", shell: true })
    expect(callMock).toHaveBeenCalledWith(
      "terminal_exec",
      expect.objectContaining({ command: "echo a && echo b", shell: true })
    )
  })

  it("completeTerminalPaths maps cwd/fragment plus options", async () => {
    callMock.mockResolvedValue([{ name: "src", isDir: true }])
    const candidates = await completeTerminalPaths({
      cwd: "/repo",
      fragment: "sr",
      showHidden: true,
      limit: 10,
    })
    expect(callMock).toHaveBeenCalledWith("terminal_complete_paths", {
      cwd: "/repo",
      fragment: "sr",
      showHidden: true,
      limit: 10,
    })
    expect(candidates).toEqual([{ name: "src", isDir: true }])
  })

  it("killTerminalPort validates the port range client-side", async () => {
    callMock.mockResolvedValue([1234])
    await expect(killTerminalPort(0)).rejects.toThrow("invalid port")
    await expect(killTerminalPort(65536)).rejects.toThrow("invalid port")
    await expect(killTerminalPort(3000.5)).rejects.toThrow("invalid port")
    expect(callMock).not.toHaveBeenCalled()
    await expect(killTerminalPort(3000)).resolves.toEqual([1234])
    expect(callMock).toHaveBeenCalledWith("terminal_kill_port", { port: 3000 })
  })

  it("propagates transport rejections (e.g. 403 remote-control denial)", async () => {
    callMock.mockRejectedValue(new Error("remote control not allowed"))
    await expect(execTerminalCommand({ command: "true" })).rejects.toThrow(
      "remote control not allowed"
    )
  })
})

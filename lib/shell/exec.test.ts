import { invoke } from "@tauri-apps/api/core"

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

import { isTauri } from "@/lib/tauri"
import { executeShell, formatShellResult } from "./exec"

const mockedInvoke = invoke as unknown as jest.Mock
const mockedIsTauri = isTauri as unknown as jest.Mock

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedIsTauri.mockReset()
})

describe("executeShell", () => {
  it("throws when not running in Tauri", async () => {
    mockedIsTauri.mockReturnValue(false)
    await expect(executeShell("ls", "/")).rejects.toThrow(/desktop/i)
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it("invokes shell_exec with the named args and converts the result", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedInvoke.mockResolvedValue({
      stdout: "out",
      stderr: "err",
      exit_code: 0,
      timed_out: false,
      stdout_truncated: false,
      stderr_truncated: true,
    })
    const out = await executeShell("ls", "/", 30)
    expect(mockedInvoke).toHaveBeenCalledWith("shell_exec", {
      cmd: "ls",
      cwd: "/",
      timeoutSecs: 30,
    })
    expect(out).toEqual({
      stdout: "out",
      stderr: "err",
      exitCode: 0,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: true,
    })
  })

  it("forwards null for unspecified timeout", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedInvoke.mockResolvedValue({
      stdout: "",
      stderr: "",
      exit_code: null,
      timed_out: true,
      stdout_truncated: false,
      stderr_truncated: false,
    })
    await executeShell("x", "/")
    expect(mockedInvoke).toHaveBeenCalledWith(
      "shell_exec",
      expect.objectContaining({ timeoutSecs: null })
    )
  })
})

describe("formatShellResult", () => {
  const base = {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  }

  it("renders 'no output' when both streams are blank", () => {
    const md = formatShellResult("ls", base)
    expect(md).toContain("`$ ls` *(exit 0)*")
    expect(md).toContain("(no output)")
  })

  it("renders stdout in a code fence", () => {
    const md = formatShellResult("ls", { ...base, stdout: "alpha\n" })
    expect(md).toContain("```")
    expect(md).toContain("alpha")
    expect(md).not.toContain("(no output)")
  })

  it("renders stderr separately and tags status text", () => {
    const md = formatShellResult("rm", { ...base, exitCode: 2, stderr: "boom" })
    expect(md).toContain("exit 2")
    expect(md).toContain("**stderr**")
    expect(md).toContain("boom")
  })

  it("uses 'timed out' status when applicable", () => {
    const md = formatShellResult("sleep", { ...base, timedOut: true })
    expect(md).toContain("timed out")
  })

  it("uses ? for missing exit code", () => {
    const md = formatShellResult("die", { ...base, exitCode: null })
    expect(md).toContain("exit ?")
  })
})

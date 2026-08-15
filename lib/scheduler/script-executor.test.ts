/**
 * Tests for scheduler/script-executor.
 */

import { invoke } from "@tauri-apps/api/core"

let isTauriValue = true
// `executeScript` picks its runner from `lib/platform/detect` + the capability
// baseline: "tauri" → shell_exec, "headless" → jobs supervisor, "web" → refused.
let platformValue: "tauri" | "headless" | "web" = "tauri"
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => platformValue,
  isTauri: () => isTauriValue,
}))

const spawnScheduledBackgroundJobMock = jest.fn()
const readBackgroundJobOutputMock = jest.fn()
const killBackgroundJobMock = jest.fn()
const listBackgroundJobsMock = jest.fn(async () => [] as unknown[])
jest.mock("@/lib/jobs/background-jobs", () => ({
  spawnScheduledBackgroundJob: (...a: unknown[]) => spawnScheduledBackgroundJobMock(...a),
  readBackgroundJobOutput: (...a: unknown[]) => readBackgroundJobOutputMock(...a),
  killBackgroundJob: (...a: unknown[]) => killBackgroundJobMock(...a),
  listBackgroundJobs: () => listBackgroundJobsMock(),
}))

import {
  executeScript,
  validateScript,
  getScriptTemplate,
  getSupportedLanguages,
} from "./script-executor"

const mockedInvoke = invoke as unknown as jest.Mock

beforeEach(() => {
  isTauriValue = true
  platformValue = "tauri"
  mockedInvoke.mockReset()
  spawnScheduledBackgroundJobMock.mockReset()
  readBackgroundJobOutputMock.mockReset()
  killBackgroundJobMock.mockReset()
  listBackgroundJobsMock.mockReset().mockResolvedValue([])
})

describe("executeScript", () => {
  it("refuses to run on a host without the shell capability", async () => {
    isTauriValue = false
    platformValue = "web"
    const r = await executeScript({
      type: "execute_script",
      language: "python",
      code: "print(1)",
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/shell capability/i)
    expect(mockedInvoke).not.toHaveBeenCalled()
    expect(spawnScheduledBackgroundJobMock).not.toHaveBeenCalled()
  })

  it("routes through the jobs supervisor on the headless host and captures output", async () => {
    isTauriValue = false
    platformValue = "headless"
    spawnScheduledBackgroundJobMock.mockResolvedValue({ id: "job-1", status: "running" })
    readBackgroundJobOutputMock
      .mockResolvedValueOnce({
        fromOffset: 0,
        nextOffset: 5,
        data: "hello",
        status: "running",
        hasMore: false,
      })
      .mockResolvedValueOnce({
        fromOffset: 5,
        nextOffset: 6,
        data: "\n",
        status: "exited",
        exitCode: 0,
        hasMore: false,
      })
      .mockResolvedValue({
        fromOffset: 6,
        nextOffset: 6,
        data: "",
        status: "exited",
        exitCode: 0,
        hasMore: false,
      })
    listBackgroundJobsMock.mockResolvedValue([
      { id: "job-1", status: "exited", exitCode: 0, droppedOutputBytes: 0 },
    ])
    const r = await executeScript(
      { type: "execute_script", language: "bash", code: "echo hello" },
      { taskId: "task-9" }
    )
    expect(spawnScheduledBackgroundJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-9", command: expect.stringContaining("bash") })
    )
    expect(r.success).toBe(true)
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe("hello\n")
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it("kills the supervisor job when the abort signal fires", async () => {
    isTauriValue = false
    platformValue = "headless"
    const controller = new AbortController()
    spawnScheduledBackgroundJobMock.mockResolvedValue({ id: "job-2", status: "running" })
    readBackgroundJobOutputMock.mockImplementation(async () => {
      controller.abort()
      return { fromOffset: 0, nextOffset: 0, data: "", status: "running", hasMore: false }
    })
    killBackgroundJobMock.mockResolvedValue({ id: "job-2", status: "killed", exitCode: undefined })
    const r = await executeScript(
      { type: "execute_script", language: "bash", code: "sleep 30" },
      { signal: controller.signal, taskId: "task-10" }
    )
    expect(killBackgroundJobMock).toHaveBeenCalledWith("job-2")
    expect(r.success).toBe(false)
  })

  it("treats a failing kill as a killed job and still fails the run", async () => {
    isTauriValue = false
    platformValue = "headless"
    const controller = new AbortController()
    spawnScheduledBackgroundJobMock.mockResolvedValue({ id: "job-3", status: "running" })
    readBackgroundJobOutputMock.mockImplementation(async () => {
      controller.abort()
      return { fromOffset: 0, nextOffset: 0, data: "", status: "running", hasMore: false }
    })
    killBackgroundJobMock.mockRejectedValue(new Error("gone"))
    listBackgroundJobsMock.mockResolvedValue([
      { id: "job-3", status: "killed", droppedOutputBytes: 3 },
    ])
    const r = await executeScript(
      { type: "execute_script", language: "bash", code: "sleep 30" },
      { signal: controller.signal }
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/cancelled/)
  })

  it("times out a supervisor job that outlives its budget", async () => {
    isTauriValue = false
    platformValue = "headless"
    const nowSpy = jest.spyOn(Date, "now")
    let t = 1_000_000
    nowSpy.mockImplementation(() => t)
    spawnScheduledBackgroundJobMock.mockResolvedValue({ id: "job-4", status: "running" })
    readBackgroundJobOutputMock.mockImplementation(async () => {
      t += 10 * 60 * 1000 // jump past the deadline on the first drain
      return { fromOffset: 0, nextOffset: 0, data: "", status: "running", hasMore: false }
    })
    killBackgroundJobMock.mockResolvedValue({ id: "job-4", status: "killed" })
    const r = await executeScript(
      { type: "execute_script", language: "bash", code: "sleep 999", timeout_secs: 1 },
      {}
    )
    nowSpy.mockRestore()
    expect(killBackgroundJobMock).toHaveBeenCalledWith("job-4")
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/timed out/)
  })

  it("resolveDefaultScriptRunner refuses hosts without shell", async () => {
    isTauriValue = false
    platformValue = "web"
    const { resolveDefaultScriptRunner } = await import("./script-executor")
    await expect(
      resolveDefaultScriptRunner()({ command: "x", cwd: ".", timeoutSecs: 1 })
    ).rejects.toThrow(/shell capability/)
  })

  it("uses an injected runner when provided", async () => {
    const runner = jest.fn(async () => ({
      stdout: "ok",
      stderr: "",
      exit_code: 0,
      timed_out: false,
      stdout_truncated: false,
      stderr_truncated: false,
    }))
    const r = await executeScript(
      { type: "execute_script", language: "python", code: "print(1)" },
      { runner }
    )
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("python"), timeoutSecs: 300 })
    )
    expect(r.success).toBe(true)
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it("rejects unsupported languages", async () => {
    const r = await executeScript({
      type: "execute_script",
      language: "rust",
      code: "fn main(){}",
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Unsupported script language/)
  })

  it("rejects go alongside other compiled languages", async () => {
    const r = await executeScript({
      type: "execute_script",
      language: "go",
      code: "package main",
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Unsupported/)
  })

  it("rejects fully unknown languages", async () => {
    const r = await executeScript({
      type: "execute_script",
      language: "cobol",
      code: "PROCEDURE DIVISION.",
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Unsupported/)
  })

  it("runs a python script via shell_exec and reports success", async () => {
    mockedInvoke.mockResolvedValueOnce({
      stdout: "hello\n",
      stderr: "",
      exit_code: 0,
      timed_out: false,
      stdout_truncated: false,
      stderr_truncated: false,
    })
    const r = await executeScript({
      type: "execute_script",
      language: "python",
      code: 'print("hello")',
      working_dir: "/tmp",
      timeout_secs: 60,
    })

    expect(r.success).toBe(true)
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe("hello\n")
    expect(typeof r.duration_ms).toBe("number")
    expect(mockedInvoke).toHaveBeenCalledWith(
      "shell_exec",
      expect.objectContaining({ cwd: "/tmp", timeoutSecs: 60 })
    )
    const args = mockedInvoke.mock.calls[0]?.[1] as { cmd: string }
    expect(args.cmd).toContain("python")
  })

  it("treats null exit_code as success too", async () => {
    mockedInvoke.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exit_code: null,
      timed_out: false,
      stdout_truncated: false,
      stderr_truncated: false,
    })
    const r = await executeScript({
      type: "execute_script",
      language: "bash",
      code: "echo hi",
    })
    expect(r.success).toBe(true)
    expect(r.exit_code).toBeUndefined()
  })

  it("reports a timeout error string", async () => {
    mockedInvoke.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exit_code: null,
      timed_out: true,
      stdout_truncated: false,
      stderr_truncated: false,
    })
    const r = await executeScript({
      type: "execute_script",
      language: "bash",
      code: "sleep 1000",
      timeout_secs: 5,
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/timed out after 5s/)
  })

  it("reports non-zero exit codes as failures", async () => {
    mockedInvoke.mockResolvedValueOnce({
      stdout: "",
      stderr: "fail",
      exit_code: 2,
      timed_out: false,
      stdout_truncated: false,
      stderr_truncated: false,
    })
    const r = await executeScript({
      type: "execute_script",
      language: "bash",
      code: "exit 2",
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/exited with code 2/)
  })

  it("catches invoke failures and surfaces a generic error", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("shell missing"))
    const r = await executeScript({
      type: "execute_script",
      language: "bash",
      code: "echo 1",
    })
    expect(r.success).toBe(false)
    expect(r.error).toBe("shell missing")
  })

  it("coerces non-Error rejections to a string", async () => {
    mockedInvoke.mockRejectedValueOnce("boom")
    const r = await executeScript({
      type: "execute_script",
      language: "bash",
      code: "echo 1",
    })
    expect(r.error).toBe("boom")
  })

  it("clamps timeout_secs into [1, 300]", async () => {
    mockedInvoke.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exit_code: 0,
      timed_out: false,
      stdout_truncated: false,
      stderr_truncated: false,
    })
    await executeScript({
      type: "execute_script",
      language: "bash",
      code: "echo 1",
      timeout_secs: 9999,
    })
    expect(mockedInvoke.mock.calls[0]?.[1]).toMatchObject({ timeoutSecs: 300 })
  })

  it("clamps timeout_secs <=0 to 1", async () => {
    mockedInvoke.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exit_code: 0,
      timed_out: false,
      stdout_truncated: false,
      stderr_truncated: false,
    })
    await executeScript({
      type: "execute_script",
      language: "bash",
      code: "echo 1",
      timeout_secs: 0,
    })
    expect(mockedInvoke.mock.calls[0]?.[1]).toMatchObject({ timeoutSecs: 1 })
  })

  it("uses process.cwd() when no working_dir is supplied", async () => {
    mockedInvoke.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exit_code: 0,
      timed_out: false,
      stdout_truncated: false,
      stderr_truncated: false,
    })
    await executeScript({
      type: "execute_script",
      language: "bash",
      code: "echo 1",
    })
    const args = mockedInvoke.mock.calls[0]?.[1] as { cwd: string }
    expect(typeof args.cwd).toBe("string")
    expect(args.cwd.length).toBeGreaterThan(0)
  })

  it("builds a node command for javascript", async () => {
    mockedInvoke.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exit_code: 0,
      timed_out: false,
      stdout_truncated: false,
      stderr_truncated: false,
    })
    await executeScript({
      type: "execute_script",
      language: "js",
      code: "console.log(1)",
    })
    expect((mockedInvoke.mock.calls[0]?.[1] as { cmd: string }).cmd).toMatch(/node -e/)
  })

  it("builds a tsx command for typescript", async () => {
    mockedInvoke.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exit_code: 0,
      timed_out: false,
      stdout_truncated: false,
      stderr_truncated: false,
    })
    await executeScript({
      type: "execute_script",
      language: "ts",
      code: "const x: number = 1\nconsole.log(x)",
    })
    expect((mockedInvoke.mock.calls[0]?.[1] as { cmd: string }).cmd).toMatch(/tsx -e/)
  })

  it("builds a powershell command for powershell", async () => {
    mockedInvoke.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exit_code: 0,
      timed_out: false,
      stdout_truncated: false,
      stderr_truncated: false,
    })
    await executeScript({
      type: "execute_script",
      language: "pwsh",
      code: "Write-Host hi",
    })
    expect((mockedInvoke.mock.calls[0]?.[1] as { cmd: string }).cmd).toMatch(
      /powershell -EncodedCommand/
    )
  })

  it("builds a ruby command for ruby", async () => {
    mockedInvoke.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exit_code: 0,
      timed_out: false,
      stdout_truncated: false,
      stderr_truncated: false,
    })
    await executeScript({
      type: "execute_script",
      language: "ruby",
      code: "puts 1",
    })
    expect((mockedInvoke.mock.calls[0]?.[1] as { cmd: string }).cmd).toMatch(/ruby -e/)
  })
})

describe("validateScript", () => {
  it("flags empty code", () => {
    const r = validateScript("python", "   ")
    expect(r.valid).toBe(false)
    expect(r.errors).toEqual(expect.arrayContaining([expect.stringMatching(/empty/i)]))
  })

  it("flags missing language", () => {
    const r = validateScript("", "print(1)")
    expect(r.valid).toBe(false)
  })

  it("flags rm -rf as a hard error in any language", () => {
    const r = validateScript("python", 'import os; os.system("rm -rf /")')
    expect(r.valid).toBe(false)
  })

  it("flags format c: as a hard error", () => {
    const r = validateScript("powershell", "format c:")
    expect(r.valid).toBe(false)
  })

  it("warns about os.system in python", () => {
    const r = validateScript("python", 'import os\nos.system("ls")')
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it("warns about subprocess in python", () => {
    const r = validateScript("python3", 'subprocess.call(["ls"])')
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it("warns about eval/exec in python", () => {
    const r = validateScript("python", 'eval("1+1")\nexec("y=2")')
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it("warns about eval / new Function in javascript", () => {
    const r = validateScript("javascript", 'eval("1");\nnew Function("return 1")();')
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it("warns about eval in typescript", () => {
    const r = validateScript("typescript", 'eval("x")')
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it("flags fork bombs in shell scripts", () => {
    const r = validateScript("bash", ":() {:|")
    expect(r.valid).toBe(false)
  })

  it("flags direct disk writes in shell scripts", () => {
    const r = validateScript("sh", "echo > /dev/sda")
    expect(r.valid).toBe(false)
  })

  it("falls through to common rules for unrecognised languages", () => {
    const r = validateScript("cobol", "nothing dangerous")
    expect(r.valid).toBe(true)
    expect(r.warnings).toEqual([])
  })

  it("flags scripts larger than 1MB", () => {
    const big = "a".repeat(1024 * 1024 + 1)
    const r = validateScript("python", big)
    expect(r.valid).toBe(false)
    expect(r.errors).toEqual(expect.arrayContaining([expect.stringMatching(/maximum size/)]))
  })
})

describe("getScriptTemplate / getSupportedLanguages", () => {
  it("returns python template", () => {
    expect(getScriptTemplate("python")).toMatch(/print/)
    expect(getScriptTemplate("python3")).toMatch(/print/)
  })

  it("returns javascript / typescript / shell / powershell / ruby templates", () => {
    expect(getScriptTemplate("js")).toMatch(/console\.log/)
    expect(getScriptTemplate("javascript")).toMatch(/console\.log/)
    expect(getScriptTemplate("ts")).toMatch(/console\.log/)
    expect(getScriptTemplate("typescript")).toMatch(/console\.log/)
    expect(getScriptTemplate("bash")).toMatch(/^#!\/bin\/bash/)
    expect(getScriptTemplate("sh")).toMatch(/^#!\/bin\/bash/)
    expect(getScriptTemplate("shell")).toMatch(/^#!\/bin\/bash/)
    expect(getScriptTemplate("powershell")).toMatch(/Write-Host/)
    expect(getScriptTemplate("pwsh")).toMatch(/Write-Host/)
    expect(getScriptTemplate("ruby")).toMatch(/puts/)
  })

  it("returns empty string for unknown languages", () => {
    expect(getScriptTemplate("rust")).toBe("")
  })

  it("exposes the supported language list", () => {
    expect(getSupportedLanguages()).toEqual(
      expect.arrayContaining(["python", "javascript", "typescript", "bash", "powershell", "ruby"])
    )
  })
})

/**
 * @jest-environment node
 */
import { runExec, runGit, type ExecFn } from "./run-git"

describe("runExec", () => {
  it("captures stdout and a zero exit code", async () => {
    const res = await runExec(process.execPath, ["-e", "process.stdout.write('hi')"])
    expect(res.code).toBe(0)
    expect(res.stdout).toBe("hi")
  })

  it("surfaces a non-zero exit code without throwing", async () => {
    const res = await runExec(process.execPath, ["-e", "process.exit(3)"])
    expect(res.code).toBe(3)
  })

  it("reports 127 when the executable is not found", async () => {
    const res = await runExec("definitely-not-a-real-binary-xyz", ["--version"])
    expect(res.code).toBe(127)
  })
})

describe("runGit", () => {
  it("prefixes safety flags and passes cwd through the exec seam", async () => {
    const calls: { file: string; args: string[]; cwd?: string }[] = []
    const fake: ExecFn = (file, args, opts) => {
      calls.push({ file, args, cwd: opts?.cwd })
      return Promise.resolve({ stdout: "", stderr: "", code: 0 })
    }
    await runGit(["status", "--porcelain"], "/repo", fake)
    expect(calls[0]).toEqual({
      file: "git",
      args: ["-c", "core.quotepath=false", "--no-optional-locks", "status", "--porcelain"],
      cwd: "/repo",
    })
  })
})

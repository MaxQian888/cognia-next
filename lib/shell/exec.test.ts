import { formatShellResult } from "./exec"

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

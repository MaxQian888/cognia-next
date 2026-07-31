/**
 * @jest-environment node
 */
import { buildBashAnalysisPrompt, formatBashResult, parseBang } from "./bash-shellout"

describe("parseBang", () => {
  it("extracts the command after the bang", () => {
    expect(parseBang("!ls -la")).toBe("ls -la")
    expect(parseBang("!  git status  ")).toBe("git status")
  })
  it("returns null for non-bang lines or an empty command", () => {
    expect(parseBang("ls")).toBeNull()
    expect(parseBang("/help")).toBeNull()
    expect(parseBang("!")).toBeNull()
    expect(parseBang("!   ")).toBeNull()
  })
})

describe("formatBashResult", () => {
  it("joins stdout, stderr and a non-zero exit note", () => {
    expect(formatBashResult({ stdout: "out\n", stderr: "", code: 0 })).toBe("out")
    expect(formatBashResult({ stdout: "out", stderr: "warn", code: 0 })).toBe("out\nwarn")
    expect(formatBashResult({ stdout: "", stderr: "boom", code: 2 })).toBe("boom\n[exit 2]")
  })
  it("falls back to a no-output marker", () => {
    expect(formatBashResult({ stdout: "", stderr: "", code: 0 })).toBe("[no output]")
  })
  it("shows an interrupted note instead of the exit code when aborted", () => {
    expect(formatBashResult({ stdout: "partial", stderr: "", code: 130, aborted: true })).toBe(
      "partial\n[interrupted]"
    )
    // Aborted with no captured output still surfaces the interruption.
    expect(formatBashResult({ stdout: "", stderr: "", code: 130, aborted: true })).toBe(
      "[interrupted]"
    )
  })
})

describe("buildBashAnalysisPrompt", () => {
  it("embeds the command, exit code, and captured output", () => {
    const prompt = buildBashAnalysisPrompt({
      command: "npm run build",
      output: "Error: boom\n[exit 1]",
      exitCode: 1,
    })
    expect(prompt).toContain("exit code 1")
    expect(prompt).toContain("npm run build")
    expect(prompt).toContain("Error: boom")
  })
  it("tolerates a missing exit code and empty output", () => {
    const prompt = buildBashAnalysisPrompt({ command: "x", output: "   " })
    expect(prompt).not.toContain("exit code")
    expect(prompt).toContain("[no output]")
  })
})

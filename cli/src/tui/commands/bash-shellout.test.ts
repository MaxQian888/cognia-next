/**
 * @jest-environment node
 */
import { formatBashResult, parseBang } from "./bash-shellout"

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
})

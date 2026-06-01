import { extractCommand, isCommandTool } from "./command-from-tool"

describe("isCommandTool", () => {
  it("recognizes the shell tools", () => {
    expect(isCommandTool("Bash")).toBe(true)
    expect(isCommandTool("shell_execute_advanced")).toBe(true)
    expect(isCommandTool("start_process")).toBe(true)
  })

  it("rejects non-shell tools", () => {
    expect(isCommandTool("Read")).toBe(false)
    expect(isCommandTool("Edit")).toBe(false)
    expect(isCommandTool("desktop_click")).toBe(false)
  })
})

describe("extractCommand", () => {
  it("reads Bash.command", () => {
    expect(extractCommand("Bash", { command: "git status" })).toBe("git status")
  })

  it("joins shell_execute_advanced command + args", () => {
    expect(
      extractCommand("shell_execute_advanced", { command: "git", args: ["status", "-s"] })
    ).toBe("git status -s")
  })

  it("joins start_process program + args", () => {
    expect(extractCommand("start_process", { program: "node", args: ["x.js"] })).toBe("node x.js")
  })

  it("returns null for a non-command tool", () => {
    expect(extractCommand("Read", { file_path: "/x" })).toBeNull()
  })

  it("returns null for a missing / non-string command", () => {
    expect(extractCommand("Bash", {})).toBeNull()
    expect(extractCommand("Bash", { command: 123 })).toBeNull()
    expect(extractCommand("Bash", null)).toBeNull()
  })

  it("tolerates missing args arrays", () => {
    expect(extractCommand("start_process", { program: "ls" })).toBe("ls")
  })
})

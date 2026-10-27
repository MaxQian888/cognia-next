import { SHELL_TOOL_NAMES, shellCommandOf } from "./shell-command"

describe("shellCommandOf", () => {
  it("reads a command from a shell-named tool regardless of its other keys", () => {
    expect(shellCommandOf("Bash", { command: "ls", timeout: 5, anything: true })).toBe("ls")
    expect(shellCommandOf("run_shell_command", { command: "pwd" })).toBe("pwd")
  })

  it("reads a command from any tool whose arguments are only shell arguments", () => {
    // An ACP agent titles the call freely ("Running: echo hi").
    expect(shellCommandOf("Running: echo hi", { command: "echo hi", cwd: "/w" })).toBe("echo hi")
  })

  it("joins an argv array, quoting only where needed", () => {
    expect(shellCommandOf("exec_command", { command: ["bash", "-lc", "echo hi"] })).toBe(
      "bash -lc 'echo hi'"
    )
    expect(shellCommandOf("exec_command", { cmd: ["echo", "it's"] })).toBe(`echo 'it'\\''s'`)
  })

  it("does not claim a non-shell tool that happens to carry a `command` key", () => {
    expect(shellCommandOf("slash_runner", { command: "deploy", target: "prod" })).toBeUndefined()
    expect(shellCommandOf("Bash", { command: "  " })).toBeUndefined()
    expect(shellCommandOf("Bash", { command: 42 })).toBeUndefined()
  })
})

it("names the shell tools of every runtime that reaches a chat surface", () => {
  for (const name of ["bash", "shell", "local_shell", "exec_command", "run_terminal_cmd"])
    expect(SHELL_TOOL_NAMES.has(name)).toBe(true)
})

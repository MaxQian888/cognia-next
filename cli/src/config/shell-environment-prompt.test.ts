/** @jest-environment node */
import { buildShellEnvironmentSection, describeShell, shellName } from "./shell-environment-prompt"

describe("shellName", () => {
  it("takes the binary's name off either kind of path", () => {
    expect(shellName("/bin/zsh")).toBe("zsh")
    expect(shellName("C:\\Windows\\System32\\cmd.exe")).toBe("cmd.exe")
    expect(shellName("bash")).toBe("bash")
  })

  it("says nothing when the environment names no shell", () => {
    expect(shellName(undefined)).toBeUndefined()
    expect(shellName("   ")).toBeUndefined()
  })
})

describe("describeShell", () => {
  it("names the shell the environment reports", () => {
    expect(describeShell({ platform: "darwin", shell: "/bin/zsh" })).toBe("zsh")
  })

  it("says what it does not know rather than guessing a shell", () => {
    expect(describeShell({ platform: "linux" })).toContain("unnamed")
    expect(describeShell({ platform: "win32" })).toContain("cmd.exe")
  })
})

describe("buildShellEnvironmentSection", () => {
  it("states the interpreter and the platform", () => {
    const section = buildShellEnvironmentSection({ platform: "darwin", shell: "/bin/zsh" })
    expect(section).toContain("Interpreter: zsh")
    expect(section).toContain("Platform: darwin")
  })

  // The failures that prompted this: a chained command whose exit status came
  // from the wrong half, and a redirect to a device a sandbox refuses.
  it("rules out chaining and device redirection everywhere", () => {
    const section = buildShellEnvironmentSection({ platform: "linux" })
    expect(section).toContain("One command per call")
    expect(section).toContain("/dev/null")
  })

  it("warns about BSD utilities only on macOS", () => {
    expect(buildShellEnvironmentSection({ platform: "darwin" })).toContain("BSD")
    expect(buildShellEnvironmentSection({ platform: "linux" })).not.toContain("BSD")
  })

  it("warns about paths and PATH only on Windows", () => {
    expect(buildShellEnvironmentSection({ platform: "win32" })).toContain("backslashes")
    expect(buildShellEnvironmentSection({ platform: "darwin" })).not.toContain("backslashes")
  })

  it("names the runtime whose sandbox is actually in force", () => {
    const section = buildShellEnvironmentSection({
      platform: "darwin",
      externalBackend: "pi-rpc",
    })
    // Whose sandbox it is decides whether a refusal is worth retrying, and
    // Cognia cannot widen one it does not own.
    expect(section).toContain("pi-rpc")
    expect(section).toContain("cannot widen")
  })

  it("names no runtime when the tools run here", () => {
    // The rules still mention that a shell CAN be sandboxed, because that is
    // true everywhere. What must not appear is a runtime this session is not
    // using, which would tell the model to stop retrying the wrong thing.
    const section = buildShellEnvironmentSection({ platform: "darwin" })
    expect(section).not.toContain("cannot widen")
    expect(section).not.toContain("Commands run inside")
  })
})

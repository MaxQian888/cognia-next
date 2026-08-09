import {
  findProfile,
  formatProfileArgs,
  formatProfileEnv,
  formatStartupCommands,
  nextProfileId,
  parseProfileArgs,
  parseProfileEnv,
  parseStartupCommands,
  profileToSpawnFields,
  type TerminalProfile,
} from "./profiles"

const sample: TerminalProfile[] = [
  { id: "profile-1", name: "PowerShell", shell: "pwsh.exe" },
  {
    id: "profile-2",
    name: "Repo bash",
    shell: "/bin/bash",
    cwd: "/work",
    args: ["-l"],
    env: { FOO: "1" },
  },
]

describe("terminal profiles", () => {
  it("findProfile resolves by id and returns undefined otherwise", () => {
    expect(findProfile(sample, "profile-2")?.name).toBe("Repo bash")
    expect(findProfile(sample, "missing")).toBeUndefined()
    expect(findProfile(undefined, "profile-1")).toBeUndefined()
    expect(findProfile(sample, undefined)).toBeUndefined()
  })

  it("profileToSpawnFields maps owned fields and drops empties", () => {
    expect(profileToSpawnFields(sample[0])).toEqual({
      shell: "pwsh.exe",
      cwd: undefined,
      args: undefined,
      env: undefined,
    })
    expect(profileToSpawnFields(sample[1])).toEqual({
      shell: "/bin/bash",
      cwd: "/work",
      args: ["-l"],
      env: { FOO: "1" },
    })
  })

  it("profileToSpawnFields rejects a blank shell", () => {
    expect(profileToSpawnFields({ id: "x", name: "x", shell: "   " })).toBeNull()
    expect(profileToSpawnFields({ id: "x", name: "x", shell: "" })).toBeNull()
  })

  it("parseProfileArgs splits lines, trims, and drops blanks", () => {
    expect(parseProfileArgs("-l\n\n  --login  \n")).toEqual(["-l", "--login"])
    // Interior whitespace inside one line is preserved (a single argv entry).
    expect(parseProfileArgs("-Command Get-ChildItem")).toEqual(["-Command Get-ChildItem"])
    expect(parseProfileArgs("")).toBeUndefined()
    expect(parseProfileArgs("  \n \n")).toBeUndefined()
  })

  it("formatProfileArgs round-trips with parseProfileArgs", () => {
    expect(formatProfileArgs(["-l", "--login"])).toBe("-l\n--login")
    expect(formatProfileArgs(undefined)).toBe("")
    expect(parseProfileArgs(formatProfileArgs(["-NoLogo"]))).toEqual(["-NoLogo"])
  })

  it("parseProfileEnv parses KEY=VALUE lines and skips malformed ones", () => {
    expect(parseProfileEnv("FOO=1\r\nBAR=two words")).toEqual({ FOO: "1", BAR: "two words" })
    // Value keeps further `=` verbatim.
    expect(parseProfileEnv("PATH=C:\\x=y")).toEqual({ PATH: "C:\\x=y" })
    // An empty value is a legitimate entry (unsetting-style overrides).
    expect(parseProfileEnv("EMPTY=")).toEqual({ EMPTY: "" })
    // No `=`, empty key, and blank lines are skipped.
    expect(parseProfileEnv("JUSTAKEY\n=novalue-key\n\nOK=1")).toEqual({ OK: "1" })
    expect(parseProfileEnv("")).toBeUndefined()
    expect(parseProfileEnv("garbage")).toBeUndefined()
  })

  it("formatProfileEnv round-trips with parseProfileEnv", () => {
    expect(formatProfileEnv({ FOO: "1", BAR: "x=y" })).toBe("FOO=1\nBAR=x=y")
    expect(formatProfileEnv(undefined)).toBe("")
    expect(parseProfileEnv(formatProfileEnv({ NODE_ENV: "development" }))).toEqual({
      NODE_ENV: "development",
    })
  })

  it("nextProfileId avoids collisions with existing ids", () => {
    expect(nextProfileId(undefined)).toBe("profile-1")
    expect(nextProfileId(sample)).toBe("profile-3")
    // Gap / out-of-order ids still resolve to an unused id.
    const gapped: TerminalProfile[] = [{ id: "profile-3", name: "x", shell: "sh" }]
    expect(nextProfileId(gapped)).toBe("profile-2")
  })

  it("parseStartupCommands splits lines, trims, and drops blanks", () => {
    expect(parseStartupCommands("source ~/.env\n\ncd project\n")).toEqual([
      "source ~/.env",
      "cd project",
    ])
    expect(parseStartupCommands("")).toBeUndefined()
    expect(parseStartupCommands("  \n  \n")).toBeUndefined()
  })

  it("formatStartupCommands round-trips with parseStartupCommands", () => {
    expect(formatStartupCommands(["nvm use 18", "clear"])).toBe("nvm use 18\nclear")
    expect(formatStartupCommands(undefined)).toBe("")
    expect(parseStartupCommands(formatStartupCommands(["echo hello"]))).toEqual(["echo hello"])
  })

  it("TerminalProfile supports startupCommands field", () => {
    const profile: TerminalProfile = {
      id: "profile-99",
      name: "Dev",
      shell: "zsh",
      startupCommands: ["nvm use 20", "cd ~/project"],
    }
    expect(profile.startupCommands).toHaveLength(2)
  })
})

import { findProfile, nextProfileId, profileToSpawnFields, type TerminalProfile } from "./profiles"

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

  it("nextProfileId avoids collisions with existing ids", () => {
    expect(nextProfileId(undefined)).toBe("profile-1")
    expect(nextProfileId(sample)).toBe("profile-3")
    // Gap / out-of-order ids still resolve to an unused id.
    const gapped: TerminalProfile[] = [{ id: "profile-3", name: "x", shell: "sh" }]
    expect(nextProfileId(gapped)).toBe("profile-2")
  })
})

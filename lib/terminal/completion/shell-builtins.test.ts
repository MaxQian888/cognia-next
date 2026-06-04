import { shellBuiltins } from "./shell-builtins"

describe("shellBuiltins", () => {
  it("returns POSIX builtins for bash/zsh/sh", () => {
    expect(shellBuiltins("bash")).toContain("cd")
    expect(shellBuiltins("bash")).toContain("pushd")
    expect(shellBuiltins("zsh")).toContain("source")
    expect(shellBuiltins("sh")).toContain("export")
    expect(shellBuiltins("sh")).not.toContain("shopt")
  })

  it("returns cmdlets + aliases for PowerShell flavors", () => {
    for (const shell of ["pwsh", "powershell"] as const) {
      const list = shellBuiltins(shell)
      expect(list).toContain("Get-ChildItem")
      expect(list).toContain("Set-Location")
      expect(list).toContain("ls")
    }
  })

  it("returns cmd internals for cmd", () => {
    const list = shellBuiltins("cmd")
    expect(list).toContain("dir")
    expect(list).toContain("cls")
  })

  it("returns fish and nu specifics", () => {
    expect(shellBuiltins("fish")).toContain("abbr")
    expect(shellBuiltins("nu")).toContain("par-each")
  })

  it("returns an empty list for unknown shells", () => {
    expect(shellBuiltins("unknown")).toEqual([])
  })

  it("is sorted and deduped", () => {
    const list = shellBuiltins("bash")
    expect(new Set(list).size).toBe(list.length)
    const sorted = [...list].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    expect(list).toEqual(sorted)
  })
})

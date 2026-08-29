import type { ShellKind } from "@/lib/terminal/shell-detect"
import { buildShellInvocation, isShellFamilySupported } from "./shell-argv"

describe("buildShellInvocation", () => {
  it("uses the bundled -lc form for the POSIX families", () => {
    for (const kind of ["sh", "bash", "zsh"] as const) {
      expect(buildShellInvocation(`/bin/${kind}`, kind, "ls -la")).toEqual({
        ok: true,
        program: `/bin/${kind}`,
        args: ["-lc", "ls -la"],
      })
    }
  })

  it("splits the flags for fish, which rejects the bundled form", () => {
    expect(buildShellInvocation("fish", "fish", "ls")).toEqual({
      ok: true,
      program: "fish",
      args: ["-l", "-c", "ls"],
    })
  })

  it("uses --login -c for nushell", () => {
    expect(buildShellInvocation("nu", "nu", "ls")).toEqual({
      ok: true,
      program: "nu",
      args: ["--login", "-c", "ls"],
    })
  })

  it("suppresses the banner for both PowerShells", () => {
    for (const kind of ["pwsh", "powershell"] as const) {
      expect(buildShellInvocation(`${kind}.exe`, kind, "Get-ChildItem")).toEqual({
        ok: true,
        program: `${kind}.exe`,
        args: ["-NoLogo", "-Command", "Get-ChildItem"],
      })
    }
  })

  it("uses /D /S /C for cmd", () => {
    expect(buildShellInvocation("cmd.exe", "cmd", "dir")).toEqual({
      ok: true,
      program: "cmd.exe",
      args: ["/D", "/S", "/C", "dir"],
    })
  })

  it("passes the shell path through untouched", () => {
    const out = buildShellInvocation("/nix/store/abc-zsh/bin/zsh", "zsh", "ls")
    expect(out).toMatchObject({ ok: true, program: "/nix/store/abc-zsh/bin/zsh" })
  })

  it("never splits the command string, however it is punctuated", () => {
    const command = `grep "a b" | wc -l && echo 'done'`
    const out = buildShellInvocation("/bin/bash", "bash", command)
    expect(out).toMatchObject({ ok: true, args: ["-lc", command] })
  })
})

describe("isShellFamilySupported", () => {
  const EVERY_KIND: ShellKind[] = [
    "sh",
    "bash",
    "zsh",
    "fish",
    "nu",
    "pwsh",
    "powershell",
    "cmd",
    "unknown",
  ]

  it("agrees with buildShellInvocation on every family in the vocabulary", () => {
    for (const kind of EVERY_KIND) {
      expect(isShellFamilySupported(kind)).toBe(true)
      expect(buildShellInvocation("x", kind, "y").ok).toBe(true)
    }
  })

  it("runs an unclassified shell rather than refusing it", () => {
    // ksh, ash, csh, elvish, xonsh all land on `unknown`. `!` ran under the
    // host's `sh -c` for them before this module existed; refusing would take
    // the feature away from the users it was built for.
    expect(buildShellInvocation("/bin/ksh", "unknown", "echo hi")).toEqual({
      ok: true,
      program: "/bin/ksh",
      // Plain `-c`, never the bundled `-lc`: the login flag is where the
      // exotic families disagree.
      args: ["-c", "echo hi"],
    })
    expect(isShellFamilySupported("unknown")).toBe(true)
  })
})

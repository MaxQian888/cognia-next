import type { ShellResult } from "@/lib/shell/exec"
import { detectPiCli, loadPiPackages, runPiMutation, setPiPackageEnabled } from "./host"
import type { PiHostDeps } from "./host"
import type { PiPackagesRead } from "./settings-io"
import type { PiPackageSource } from "./types"

function shell(partial: Partial<ShellResult> = {}): ShellResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...partial,
  }
}

function read(partial: Partial<PiPackagesRead> = {}): PiPackagesRead {
  return { packages: [], unparseable: false, missing: false, warnings: [], ...partial }
}

function deps(overrides: Partial<PiHostDeps> = {}): Partial<PiHostDeps> {
  return {
    isDesktop: () => true,
    exec: jest.fn(async () => shell()),
    readUser: jest.fn(async () => read()),
    readProject: jest.fn(async () => read()),
    writeUser: jest.fn(async () => ({ path: "/home/u/.pi/agent/settings.json" })),
    writeProject: jest.fn(async () => ({ path: "/repo/.pi/settings.json" })),
    piAgentDir: jest.fn(async () => "/home/u/.pi/agent"),
    ...overrides,
  }
}

describe("detectPiCli", () => {
  it("reports the version parsed out of `pi --version`", async () => {
    const result = await detectPiCli(deps({ exec: async () => shell({ stdout: "0.84.1\n" }) }))
    expect(result).toEqual({ available: true, version: "0.84.1" })
  })

  it("tolerates a name prefix in the version output", async () => {
    const result = await detectPiCli(deps({ exec: async () => shell({ stdout: "pi 0.84.1" }) }))
    expect(result.version).toBe("0.84.1")
  })

  it("reports unavailable on a non-zero exit rather than throwing", async () => {
    const result = await detectPiCli(deps({ exec: async () => shell({ exitCode: 127 }) }))
    expect(result).toEqual({ available: false })
  })

  /** A missing binary is the case the fallback exists for, not an error. */
  it("swallows a thrown exec and reports unavailable", async () => {
    const result = await detectPiCli(
      deps({
        exec: async () => {
          throw new Error("no shell")
        },
      })
    )
    expect(result).toEqual({ available: false })
  })

  it("never probes outside the desktop shell", async () => {
    const exec = jest.fn(async () => shell())
    const result = await detectPiCli(deps({ isDesktop: () => false, exec }))
    expect(result).toEqual({ available: false })
    expect(exec).not.toHaveBeenCalled()
  })
})

describe("loadPiPackages", () => {
  it("reads both scopes separately and probes the CLI", async () => {
    const readUser = jest.fn(async () => read({ packages: ["npm:a"] }))
    const readProject = jest.fn(async () => read({ packages: ["npm:b"] }))
    const snapshot = await loadPiPackages("/repo", deps({ readUser, readProject }))
    expect(snapshot.user.packages).toEqual(["npm:a"])
    expect(snapshot.project.packages).toEqual(["npm:b"])
    expect(readProject).toHaveBeenCalledWith("/repo")
    expect(snapshot.projectCwd).toBe("/repo")
  })

  /**
   * Without this, a relative `./ext` in both files resolves to one identity and
   * one of the two packages vanishes from the list.
   */
  it("carries the user base dir so local specs get distinct identities", async () => {
    const snapshot = await loadPiPackages("/repo", deps())
    expect(snapshot.userBaseDir).toBe("/home/u/.pi/agent")
  })

  it("skips the project read when no workspace is open", async () => {
    const readProject = jest.fn(async () => read())
    const snapshot = await loadPiPackages(null, deps({ readProject }))
    expect(readProject).not.toHaveBeenCalled()
    expect(snapshot.project.missing).toBe(true)
  })
})

describe("runPiMutation", () => {
  const CLI = { available: true, version: "0.84.1" }
  const NO_CLI = { available: false }

  it("shells out to Pi when the CLI is present", async () => {
    const exec = jest.fn(async () => shell({ stdout: "installed" }))
    const outcome = await runPiMutation(
      { kind: "install", spec: "npm:a", scope: "user" },
      { cwd: "/repo", cli: CLI },
      deps({ exec })
    )
    expect(outcome.ok).toBe(true)
    expect(exec).toHaveBeenCalledWith("pi install npm:a", ".", expect.any(Number))
    expect(outcome.output).toBe("installed")
  })

  /** `-l` writes into the cwd's `.pi/`, so the cwd has to be the project. */
  it("runs a project-scope mutation inside the project directory", async () => {
    const exec = jest.fn(async () => shell())
    await runPiMutation(
      { kind: "install", spec: "npm:a", scope: "project" },
      { cwd: "/repo", cli: CLI },
      deps({ exec })
    )
    expect(exec).toHaveBeenCalledWith("pi install npm:a -l", "/repo", expect.any(Number))
  })

  it("fails a project mutation with no workspace open", async () => {
    const outcome = await runPiMutation(
      { kind: "install", spec: "npm:a", scope: "project" },
      { cwd: null, cli: CLI },
      deps()
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/no project scope/i)
  })

  it("surfaces a non-zero exit with its output", async () => {
    const outcome = await runPiMutation(
      { kind: "install", spec: "npm:nope", scope: "user" },
      { cwd: null, cli: CLI },
      deps({ exec: async () => shell({ exitCode: 1, stderr: "not found" }) })
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.output).toContain("not found")
    expect(outcome.error).toContain("exited 1")
  })

  it("reports a timeout distinctly from a failure exit", async () => {
    const outcome = await runPiMutation(
      { kind: "install", spec: "npm:a", scope: "user" },
      { cwd: null, cli: CLI },
      deps({ exec: async () => shell({ timedOut: true, exitCode: null }) })
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/timed out/i)
  })

  it("edits settings.json when Pi is not on PATH", async () => {
    const writeUser = jest.fn(async () => ({ path: "/p" }))
    const outcome = await runPiMutation(
      { kind: "install", spec: "npm:b", scope: "user" },
      { cwd: null, cli: NO_CLI },
      deps({ readUser: async () => read({ packages: ["npm:a"] }), writeUser })
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.plan.degradedReason).toBe("pi-unavailable")
    expect(writeUser).toHaveBeenCalledWith(["npm:a", "npm:b"])
  })

  /**
   * The bug this guard exists for: serializing over an unparseable file
   * replaces every preference the user has with `{ packages: [...] }`.
   */
  it("refuses the fallback when the settings file is unparseable", async () => {
    const writeUser = jest.fn(async () => ({ path: "/p" }))
    const outcome = await runPiMutation(
      { kind: "install", spec: "npm:b", scope: "user" },
      { cwd: null, cli: NO_CLI },
      deps({ readUser: async () => read({ unparseable: true }), writeUser })
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/could not be parsed/i)
    expect(writeUser).not.toHaveBeenCalled()
  })

  it("removes via the fallback by identity, ignoring the pin", async () => {
    const writeUser = jest.fn(async () => ({ path: "/p" }))
    await runPiMutation(
      { kind: "remove", spec: "npm:a@9.9.9", scope: "user" },
      { cwd: null, cli: NO_CLI },
      deps({ readUser: async () => read({ packages: ["npm:a@1.0.0", "npm:b"] }), writeUser })
    )
    expect(writeUser).toHaveBeenCalledWith(["npm:b"])
  })

  it("writes the project file on a project-scope fallback", async () => {
    const writeProject = jest.fn(async () => ({ path: "/repo/.pi/settings.json" }))
    await runPiMutation(
      { kind: "install", spec: "npm:a", scope: "project" },
      { cwd: "/repo", cli: NO_CLI },
      deps({ writeProject })
    )
    expect(writeProject).toHaveBeenCalledWith("/repo", ["npm:a"])
  })

  it("returns the thrown write error rather than rejecting", async () => {
    const outcome = await runPiMutation(
      { kind: "install", spec: "npm:a", scope: "user" },
      { cwd: null, cli: NO_CLI },
      deps({
        writeUser: async () => {
          throw new Error("agent directory missing")
        },
      })
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe("agent directory missing")
  })
})

describe("setPiPackageEnabled", () => {
  it("writes autoload:false to disable, matching what pi config writes", async () => {
    const writeUser = jest.fn(async () => ({ path: "/p" }))
    const result = await setPiPackageEnabled(
      "npm:a",
      "user",
      false,
      { cwd: null },
      deps({ readUser: async () => read({ packages: ["npm:a", "npm:b"] }), writeUser })
    )
    expect(result.ok).toBe(true)
    expect(writeUser).toHaveBeenCalledWith([{ source: "npm:a", autoload: false }, "npm:b"])
  })

  it("removes the key to re-enable rather than writing autoload:true", async () => {
    const writeUser = jest.fn(async () => ({ path: "/p" }))
    await setPiPackageEnabled(
      "npm:a",
      "user",
      true,
      { cwd: null },
      deps({
        readUser: async () =>
          read({ packages: [{ source: "npm:a", autoload: false }] as PiPackageSource[] }),
        writeUser,
      })
    )
    expect(writeUser).toHaveBeenCalledWith(["npm:a"])
  })

  it("refuses to toggle a package this scope does not declare", async () => {
    const writeUser = jest.fn(async () => ({ path: "/p" }))
    const result = await setPiPackageEnabled(
      "npm:missing",
      "user",
      false,
      { cwd: null },
      deps({ readUser: async () => read({ packages: ["npm:a"] }), writeUser })
    )
    expect(result.ok).toBe(false)
    expect(writeUser).not.toHaveBeenCalled()
  })

  it("refuses on an unparseable file", async () => {
    const result = await setPiPackageEnabled(
      "npm:a",
      "user",
      false,
      { cwd: null },
      deps({ readUser: async () => read({ unparseable: true }) })
    )
    expect(result.ok).toBe(false)
  })

  it("refuses project scope with no workspace open", async () => {
    const result = await setPiPackageEnabled("npm:a", "project", false, { cwd: null }, deps())
    expect(result.ok).toBe(false)
  })
})

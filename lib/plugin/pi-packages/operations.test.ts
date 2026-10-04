import type { PiPackagesSnapshot } from "@/lib/pi-packages/host"
import type { PluginPiPackageDef } from "@/types/plugin/plugin-pi-package"
import type { ContributedPiPackage } from "./registry"
import {
  installPiPackage,
  piPackageInstallStateFromSnapshot,
  planPiPackagePrepare,
  preparePiPackage,
  removePiPackage,
  type PiPackageOperationDeps,
} from "./operations"
import { resolveContributedPiPackage } from "./resolve"

const ROOT = "/data/cognia/plugins/latex-workbench"
const PKG_DIR = `${ROOT}/pi`
const REF = "latex-workbench/latex"

function entry(
  overrides: Partial<PluginPiPackageDef> = {},
  installRoot = ROOT
): ContributedPiPackage {
  const def: PluginPiPackageDef = {
    id: "latex",
    name: "LaTeX",
    path: "pi",
    prepare: {
      program: "npm",
      args: ["ci", "--ignore-scripts", "--prefix", "with space"],
      marker: "pi/node_modules/.package-lock.json",
      timeoutMs: 9_000_000,
    },
    ...overrides,
  }
  return { def, installRoot, pluginId: "latex-workbench", ref: REF }
}

function snapshot(overrides: Partial<PiPackagesSnapshot> = {}): PiPackagesSnapshot {
  return {
    user: { packages: [], unparseable: false, missing: false, warnings: [] },
    project: { packages: [], unparseable: false, missing: true, warnings: [] },
    cli: { available: true, version: "0.85.1" },
    projectCwd: null,
    userBaseDir: "/home/me/.pi/agent",
    ...overrides,
  }
}

function makeDeps(
  pkg: ContributedPiPackage | undefined,
  options: { markers?: boolean[] } = {}
): PiPackageOperationDeps & {
  exec: jest.Mock
  audit: jest.Mock
  mutate: jest.Mock
} {
  const markers = [...(options.markers ?? [false, true])]
  const exec = jest.fn(async () => ({
    stdout: "added 12 packages",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    truncated: false,
  }))
  const audit = jest.fn(async () => undefined)
  const mutate = jest.fn(async (request: { kind: string }) => ({
    ok: true,
    plan: { strategy: "pi-cli", command: `pi ${request.kind} ${PKG_DIR}` },
    output: "ok",
  }))
  return {
    exec,
    audit,
    mutate,
    isDesktop: () => true,
    detect: async () => ({
      available: true,
      version: "10.0.0",
      path: "/usr/local/bin/npm",
      error: null,
    }),
    invokeExec: exec,
    appendAudit: audit,
    now: () => 1000,
    runMutation: mutate as unknown as PiPackageOperationDeps["runMutation"],
    findSymlink: jest.fn(async () => null),
    resolveDeps: {
      lookup: () => pkg,
      getPluginConfig: () => ({}),
      markerExists: async () => (markers.length > 1 ? markers.shift()! : markers[0]),
    },
  }
}

describe("planPiPackagePrepare", () => {
  it("renders the exact argv, cwd, clamped timeout and marker", async () => {
    const resolved = await resolveContributedPiPackage(REF, {
      deps: { lookup: () => entry(), markerExists: async () => false },
    })
    expect(planPiPackagePrepare(resolved)).toEqual({
      ref: REF,
      pluginId: "latex-workbench",
      packageId: "latex",
      program: "npm",
      args: ["ci", "--ignore-scripts", "--prefix", "with space", "--no-bin-links"],
      cwd: PKG_DIR,
      timeoutMs: 600_000,
      markerPath: `${ROOT}/pi/node_modules/.package-lock.json`,
      commandLine: 'npm ci --ignore-scripts --prefix "with space" --no-bin-links',
    })
  })

  it("adds --no-bin-links to npm once, and leaves pnpm argv untouched", async () => {
    const already = await resolveContributedPiPackage(REF, {
      deps: {
        lookup: () => entry({ prepare: { program: "npm", args: ["ci", "--no-bin-links"] } }),
      },
    })
    expect(planPiPackagePrepare(already)?.args).toEqual(["ci", "--no-bin-links"])
    const pnpm = await resolveContributedPiPackage(REF, {
      deps: { lookup: () => entry({ prepare: { program: "pnpm", args: ["install"] } }) },
    })
    expect(planPiPackagePrepare(pnpm)?.args).toEqual(["install"])
  })

  it("returns null when no prepare is declared", async () => {
    const resolved = await resolveContributedPiPackage(REF, {
      deps: { lookup: () => entry({ prepare: undefined }) },
    })
    expect(planPiPackagePrepare(resolved)).toBeNull()
  })
})

describe("preparePiPackage", () => {
  it("asks for consent with the plan, spawns without a shell, audits and re-checks the marker", async () => {
    const deps = makeDeps(entry())
    const confirm = jest.fn(async () => true)
    const outcome = await preparePiPackage(REF, { confirm, deps })
    expect(outcome.ok).toBe(true)
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        commandLine: 'npm ci --ignore-scripts --prefix "with space" --no-bin-links',
      })
    )
    expect(deps.exec).toHaveBeenCalledWith({
      pluginId: "latex-workbench",
      toolName: "pi-package-prepare:latex",
      program: "/usr/local/bin/npm",
      args: ["ci", "--ignore-scripts", "--prefix", "with space", "--no-bin-links"],
      cwd: PKG_DIR,
      env: {},
      stdin: null,
      timeoutMs: 600_000,
      maxOutputBytes: null,
    })
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "latex-workbench", surface: "plugin", error: null })
    )
    expect(outcome.output).toBe("added 12 packages")
  })

  it("spawns nothing when the user declines (or the prompt throws)", async () => {
    const deps = makeDeps(entry())
    expect((await preparePiPackage(REF, { confirm: async () => false, deps })).code).toBe(
      "declined"
    )
    expect(
      (
        await preparePiPackage(REF, {
          confirm: async () => {
            throw new Error("closed")
          },
          deps,
        })
      ).code
    ).toBe("declined")
    expect(deps.exec).not.toHaveBeenCalled()
  })

  it("is desktop-only", async () => {
    const deps = { ...makeDeps(entry()), isDesktop: () => false }
    const confirm = jest.fn(async () => true)
    expect((await preparePiPackage(REF, { confirm, deps })).code).toBe("desktop-only")
    expect(confirm).not.toHaveBeenCalled()
  })

  it("reports a missing package manager after consent, without spawning", async () => {
    const deps = {
      ...makeDeps(entry()),
      detect: async () => ({ available: false, version: null, path: null, error: "nf" }),
    }
    const outcome = await preparePiPackage(REF, { confirm: async () => true, deps })
    expect(outcome.code).toBe("binary-missing")
    expect(deps.exec).not.toHaveBeenCalled()
  })

  it("maps timeout, non-zero exit and spawn failure", async () => {
    const timedOut = makeDeps(entry())
    timedOut.exec.mockResolvedValueOnce({
      stdout: "",
      stderr: "slow",
      exitCode: null,
      timedOut: true,
      truncated: false,
    })
    expect((await preparePiPackage(REF, { confirm: async () => true, deps: timedOut })).code).toBe(
      "timeout"
    )

    const failed = makeDeps(entry())
    failed.exec.mockResolvedValueOnce({
      stdout: "",
      stderr: "ERR",
      exitCode: 1,
      timedOut: false,
      truncated: false,
    })
    const exitOutcome = await preparePiPackage(REF, { confirm: async () => true, deps: failed })
    expect(exitOutcome.code).toBe("exit-code")
    expect(exitOutcome.exitCode).toBe(1)
    expect(exitOutcome.output).toBe("ERR")

    const thrown = makeDeps(entry())
    thrown.exec.mockRejectedValueOnce(new Error("spawn ENOENT"))
    expect((await preparePiPackage(REF, { confirm: async () => true, deps: thrown })).code).toBe(
      "execution-failed"
    )
    expect(thrown.audit).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("ENOENT") })
    )
  })

  it("fails when the step left a symbolic link the plugin loader would refuse", async () => {
    const deps = { ...makeDeps(entry()), findSymlink: jest.fn(async () => "./node_modules/.bin/x") }
    const outcome = await preparePiPackage(REF, { confirm: async () => true, deps })
    expect(outcome).toMatchObject({
      ok: false,
      code: "symlinks-created",
      link: "./node_modules/.bin/x",
    })
    expect(deps.findSymlink).toHaveBeenCalledWith(PKG_DIR)
    // A probe that cannot answer does not fail an otherwise good run.
    const unknown = {
      ...makeDeps(entry()),
      findSymlink: jest.fn(async () => {
        throw new Error("no find")
      }),
    }
    expect((await preparePiPackage(REF, { confirm: async () => true, deps: unknown })).ok).toBe(
      true
    )
  })

  it("fails when the step succeeded but the marker never appeared", async () => {
    const deps = makeDeps(entry(), { markers: [false] })
    expect((await preparePiPackage(REF, { confirm: async () => true, deps })).code).toBe(
      "marker-missing"
    )
  })

  it("surfaces typed resolution failures and a missing prepare step", async () => {
    expect(
      (
        await preparePiPackage(REF, {
          confirm: async () => true,
          deps: makeDeps(entry({}, "builtin://latex-workbench")),
        })
      ).code
    ).toBe("not-on-disk")
    expect(
      (
        await preparePiPackage(REF, {
          confirm: async () => true,
          deps: makeDeps(entry({ prepare: undefined })),
        })
      ).code
    ).toBe("no-prepare")
  })
})

describe("installPiPackage / removePiPackage", () => {
  const context = { cwd: "/work/thesis", cli: { available: true, version: "0.85.1" } }

  it("installs with the absolute package directory as the spec", async () => {
    const deps = makeDeps(entry(), { markers: [true] })
    const outcome = await installPiPackage(REF, "project", context, deps)
    expect(outcome.ok).toBe(true)
    expect(deps.mutate).toHaveBeenCalledWith(
      { kind: "install", spec: PKG_DIR, scope: "project" },
      context
    )
  })

  it("requires prepare first when the marker is missing or unknown", async () => {
    const missing = makeDeps(entry(), { markers: [false] })
    expect(await installPiPackage(REF, "user", context, missing)).toMatchObject({
      ok: false,
      code: "needs-prepare",
      prepareState: "missing",
    })
    expect(missing.mutate).not.toHaveBeenCalled()
  })

  it("does not wait for a prepare step that declares no marker", async () => {
    const deps = makeDeps(entry({ prepare: { program: "npm", args: ["ci"] } }))
    expect((await installPiPackage(REF, "user", context, deps)).ok).toBe(true)
  })

  it("surfaces the settings-edit fallback's degraded reason", async () => {
    const deps = makeDeps(entry(), { markers: [true] })
    deps.mutate.mockResolvedValueOnce({
      ok: true,
      plan: { strategy: "settings-edit", degradedReason: "pi-unavailable" },
    })
    const outcome = await installPiPackage(
      REF,
      "user",
      { cwd: null, cli: { available: false } },
      deps
    )
    expect(outcome).toMatchObject({ ok: true, degradedReason: "pi-unavailable" })
  })

  it("passes a failed mutation through with its error", async () => {
    const deps = makeDeps(entry(), { markers: [true] })
    deps.mutate.mockResolvedValueOnce({
      ok: false,
      plan: { strategy: "pi-cli", command: "pi remove x" },
      error: "`pi remove x` exited 1.",
    })
    expect(await removePiPackage(REF, "user", context, deps)).toMatchObject({
      ok: false,
      code: "execution-failed",
      error: "`pi remove x` exited 1.",
    })
  })

  it("removes with the same spec", async () => {
    const deps = makeDeps(entry(), { markers: [true] })
    await removePiPackage(REF, "user", context, deps)
    expect(deps.mutate).toHaveBeenCalledWith(
      { kind: "remove", spec: PKG_DIR, scope: "user" },
      context
    )
  })

  it("refuses a builtin plugin before touching Pi", async () => {
    const deps = makeDeps(entry({}, "builtin://latex-workbench"))
    expect((await installPiPackage(REF, "user", context, deps)).code).toBe("not-on-disk")
    expect(deps.mutate).not.toHaveBeenCalled()
  })
})

describe("install state", () => {
  it("matches by Pi identity in each scope, including relative and object entries", () => {
    expect(
      piPackageInstallStateFromSnapshot(
        PKG_DIR,
        snapshot({
          user: {
            packages: [{ source: `${PKG_DIR}/`, autoload: false }],
            unparseable: false,
            missing: false,
            warnings: [],
          },
          project: {
            packages: ["../../../data/cognia/plugins/latex-workbench/pi"],
            unparseable: false,
            missing: false,
            warnings: [],
          },
          // `<cwd>/.pi` + `../../../data/...` resolves back to PKG_DIR.
          projectCwd: "/a/b",
        })
      )
    ).toEqual({ user: true, project: true })
  })

  it("reports project as null without a workspace", () => {
    expect(piPackageInstallStateFromSnapshot(PKG_DIR, snapshot())).toEqual({
      user: false,
      project: null,
    })
  })
})

import type { PluginPiPackageDef } from "@/types/plugin/plugin-pi-package"

const mockExecuteShell = jest.fn()
let mockOsFamily = "macos"
jest.mock("@/lib/shell/exec", () => ({
  executeShell: (...args: unknown[]) => mockExecuteShell(...args),
}))
jest.mock("@/lib/platform/os", () => ({ detectOsFamily: () => mockOsFamily }))
import type { ContributedPiPackage } from "./registry"
import {
  isOnDiskPluginRoot,
  isPiPackageReady,
  PiPackageResolutionError,
  probePiPackagePrepareState,
  resolveContributedPiPackage,
  type PiPackageResolveDeps,
} from "./resolve"

const ROOT = "/data/cognia/plugins/latex-workbench"

function pkg(
  overrides: Partial<PluginPiPackageDef> = {},
  installRoot = ROOT
): ContributedPiPackage {
  const def: PluginPiPackageDef = {
    id: "latex",
    name: "LaTeX",
    path: "pi",
    minPiVersion: "0.85.1",
    prepare: { program: "npm", args: ["ci"], marker: "pi/node_modules/.package-lock.json" },
    hostedSession: {
      extensions: ["pi/extensions/latex.ts", "./pi/extensions/preview.mjs"],
      env: [
        { name: "TEX_ENGINE", from: { config: "engine" } },
        { name: "MODE", from: { value: "hosted" } },
        { name: "WORKSPACE", from: { workspace: true } },
        { name: "UNSET", from: { config: "notSet" } },
      ],
      tools: ["latex_compile"],
      controlsSession: true,
    },
    ...overrides,
  }
  return { def, installRoot, pluginId: "latex-workbench", ref: `latex-workbench/${def.id}` }
}

function deps(
  entry: ContributedPiPackage | undefined,
  overrides: Partial<PiPackageResolveDeps> = {}
): Partial<PiPackageResolveDeps> {
  return {
    lookup: () => entry,
    getPluginConfig: () => ({ engine: "lualatex", notSet: undefined }),
    markerExists: async () => true,
    ...overrides,
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    expect(error).toBeInstanceOf(PiPackageResolutionError)
    return (error as PiPackageResolutionError).code
  }
}

describe("resolveContributedPiPackage", () => {
  it("resolves absolute paths, prepared state, env, tools and controlsSession", async () => {
    const resolved = await resolveContributedPiPackage("latex-workbench/latex", {
      cwd: "/work/thesis",
      forSession: true,
      deps: deps(pkg()),
    })
    expect(resolved).toMatchObject({
      ref: "latex-workbench/latex",
      pluginRoot: ROOT,
      packageDir: `${ROOT}/pi`,
      markerPath: `${ROOT}/pi/node_modules/.package-lock.json`,
      prepareState: "prepared",
      hosted: true,
      extensions: [`${ROOT}/pi/extensions/latex.ts`, `${ROOT}/pi/extensions/preview.mjs`],
      env: {
        COGNIA_PIPKG_TEX_ENGINE: "lualatex",
        COGNIA_PIPKG_MODE: "hosted",
        COGNIA_PIPKG_WORKSPACE: "/work/thesis",
      },
      tools: ["latex_compile"],
      controlsSession: true,
      minPiVersion: "0.85.1",
    })
    // An unset config key forwards nothing rather than the string "undefined".
    expect(resolved.env).not.toHaveProperty("COGNIA_PIPKG_UNSET")
  })

  it("resolves the prepare marker against the PLUGIN root, not the package directory", async () => {
    const markerExists = jest.fn(async () => true)
    const resolved = await resolveContributedPiPackage("latex-workbench/latex", {
      deps: deps(
        pkg({
          path: "vendor",
          prepare: {
            program: "npm",
            args: ["install"],
            marker: "vendor/node_modules/.package-lock.json",
          },
        }),
        { markerExists }
      ),
    })
    expect(resolved.packageDir).toBe(`${ROOT}/vendor`)
    expect(resolved.markerPath).toBe(`${ROOT}/vendor/node_modules/.package-lock.json`)
    // Probed relative to the plugin root — never `<packageDir>/vendor/node_modules/...`.
    expect(markerExists).toHaveBeenCalledWith(ROOT, "vendor/node_modules/.package-lock.json")
  })

  it("stringifies non-string config values", async () => {
    const resolved = await resolveContributedPiPackage("latex-workbench/latex", {
      cwd: "/w",
      deps: deps(pkg(), { getPluginConfig: async () => ({ engine: 3, notSet: { a: 1 } }) }),
    })
    expect(resolved.env.COGNIA_PIPKG_TEX_ENGINE).toBe("3")
    expect(resolved.env.COGNIA_PIPKG_UNSET).toBe('{"a":1}')
  })

  it("treats only `.` / `./` as the plugin root", async () => {
    for (const path of [".", "./"]) {
      const resolved = await resolveContributedPiPackage("latex-workbench/latex", {
        deps: deps(pkg({ path })),
      })
      expect(resolved.packageDir).toBe(ROOT)
    }
    expect(
      await codeOf(
        resolveContributedPiPackage("latex-workbench/latex", { deps: deps(pkg({ path: "./." })) })
      )
    ).toBe("invalid-path")
  })

  it("treats `.` as the plugin root and trims a trailing slash", async () => {
    const resolved = await resolveContributedPiPackage("latex-workbench/latex", {
      deps: deps(pkg({ path: "." }, `${ROOT}/`)),
    })
    expect(resolved.packageDir).toBe(ROOT)
  })

  it("refuses an unknown or disabled package", async () => {
    expect(await codeOf(resolveContributedPiPackage("x/y", { deps: deps(undefined) }))).toBe(
      "not-found"
    )
  })

  it.each(["builtin://latex-workbench", "", "relative/dir"])(
    "refuses a plugin root that is not on disk: %s",
    async (root) => {
      expect(
        await codeOf(
          resolveContributedPiPackage("latex-workbench/latex", { deps: deps(pkg({}, root)) })
        )
      ).toBe("not-on-disk")
    }
  )

  it("refuses a path that escapes the plugin directory", async () => {
    expect(
      await codeOf(
        resolveContributedPiPackage("latex-workbench/latex", {
          deps: deps(pkg({ path: "../elsewhere" })),
        })
      )
    ).toBe("invalid-path")
    expect(
      await codeOf(
        resolveContributedPiPackage("latex-workbench/latex", {
          deps: deps(pkg({ hostedSession: { extensions: ["/etc/evil.ts"] } })),
        })
      )
    ).toBe("invalid-path")
  })

  it("refuses a session for a package without hostedSession", async () => {
    expect(
      await codeOf(
        resolveContributedPiPackage("latex-workbench/latex", {
          forSession: true,
          cwd: "/w",
          deps: deps(pkg({ hostedSession: undefined })),
        })
      )
    ).toBe("not-hosted")
  })

  it("refuses a session for an unprepared package, and when the marker is unreadable", async () => {
    expect(
      await codeOf(
        resolveContributedPiPackage("latex-workbench/latex", {
          forSession: true,
          cwd: "/w",
          deps: deps(pkg(), { markerExists: async () => false }),
        })
      )
    ).toBe("not-prepared")
    expect(
      await codeOf(
        resolveContributedPiPackage("latex-workbench/latex", {
          forSession: true,
          cwd: "/w",
          deps: deps(pkg(), {
            markerExists: async () => {
              throw new Error("probe failed")
            },
          }),
        })
      )
    ).toBe("not-prepared")
  })

  it("requires a workspace for a workspace binding only when resolving for a session", async () => {
    expect(
      await codeOf(
        resolveContributedPiPackage("latex-workbench/latex", {
          forSession: true,
          deps: deps(pkg()),
        })
      )
    ).toBe("workspace-required")
    const preview = await resolveContributedPiPackage("latex-workbench/latex", {
      deps: deps(pkg()),
    })
    expect(preview.env).not.toHaveProperty("COGNIA_PIPKG_WORKSPACE")
  })

  it("does not read plugin config when no binding needs it", async () => {
    const getPluginConfig = jest.fn(() => ({}))
    await resolveContributedPiPackage("latex-workbench/latex", {
      deps: deps(
        pkg({
          hostedSession: { extensions: ["pi/x.ts"], env: [{ name: "A", from: { value: "1" } }] },
        }),
        { getPluginConfig }
      ),
    })
    expect(getPluginConfig).not.toHaveBeenCalled()
  })
})

describe("probePiPackagePrepareState", () => {
  const base: PluginPiPackageDef = { id: "p", name: "p", path: "." }
  it("maps every declaration to its state", async () => {
    const yes = async () => true
    expect(await probePiPackagePrepareState(base, ROOT, yes)).toBe("not-required")
    expect(
      await probePiPackagePrepareState(
        { ...base, prepare: { program: "npm", args: [] } },
        ROOT,
        yes
      )
    ).toBe("unverifiable")
    const marked = { ...base, prepare: { program: "npm" as const, args: [], marker: "m" } }
    expect(await probePiPackagePrepareState(marked, ROOT, yes)).toBe("prepared")
    expect(await probePiPackagePrepareState(marked, ROOT, async () => false)).toBe("missing")
    expect(
      await probePiPackagePrepareState(marked, ROOT, async () => {
        throw new Error("x")
      })
    ).toBe("unknown")
  })

  it("passes the plugin root and the plugin-relative marker to the probe", async () => {
    const probe = jest.fn(async () => true)
    await probePiPackagePrepareState(
      { ...base, prepare: { program: "npm", args: [], marker: "pi/m" } },
      ROOT,
      probe
    )
    expect(probe).toHaveBeenCalledWith(ROOT, "pi/m")
  })
})

describe("readiness helpers", () => {
  it("only blocks on missing or unknown", () => {
    expect(isPiPackageReady("not-required")).toBe(true)
    expect(isPiPackageReady("prepared")).toBe(true)
    expect(isPiPackageReady("unverifiable")).toBe(true)
    expect(isPiPackageReady("missing")).toBe(false)
    expect(isPiPackageReady("unknown")).toBe(false)
  })

  it("recognises on-disk roots only", () => {
    expect(isOnDiskPluginRoot("/a/b")).toBe(true)
    expect(isOnDiskPluginRoot("C:\\Users\\me\\plugins\\x")).toBe(true)
    expect(isOnDiskPluginRoot("\\\\server\\share\\x")).toBe(true)
    expect(isOnDiskPluginRoot("builtin://x")).toBe(false)
    expect(isOnDiskPluginRoot("")).toBe(false)
    expect(isOnDiskPluginRoot("plugins/x")).toBe(false)
  })
})

describe("default marker probe", () => {
  const marked = (): ContributedPiPackage =>
    pkg({ prepare: { program: "npm", args: [], marker: "pi/node modules/.lock" } })

  beforeEach(() => {
    mockExecuteShell.mockReset()
    mockOsFamily = "macos"
  })

  it("runs a quoted `test -e` in the plugin root on POSIX", async () => {
    mockExecuteShell.mockResolvedValue({ exitCode: 0, timedOut: false })
    const resolved = await resolveContributedPiPackage("latex-workbench/latex", {
      deps: { lookup: () => marked(), getPluginConfig: () => ({}) },
    })
    expect(mockExecuteShell).toHaveBeenCalledWith("test -e 'pi/node modules/.lock'", ROOT, 15)
    expect(resolved.prepareState).toBe("prepared")
  })

  it("uses `if exist` with backslashes on Windows", async () => {
    mockOsFamily = "windows"
    mockExecuteShell.mockResolvedValue({ exitCode: 1, timedOut: false })
    const resolved = await resolveContributedPiPackage("latex-workbench/latex", {
      deps: { lookup: () => marked(), getPluginConfig: () => ({}) },
    })
    expect(mockExecuteShell).toHaveBeenCalledWith(
      'if exist "pi\\node modules\\.lock" (exit 0) else (exit 1)',
      ROOT,
      15
    )
    expect(resolved.prepareState).toBe("missing")
  })

  it("reports unknown when the probe cannot answer", async () => {
    mockExecuteShell.mockResolvedValue({ exitCode: 127, timedOut: false })
    const resolved = await resolveContributedPiPackage("latex-workbench/latex", {
      deps: { lookup: () => marked(), getPluginConfig: () => ({}) },
    })
    expect(resolved.prepareState).toBe("unknown")
    mockExecuteShell.mockResolvedValue({ exitCode: null, timedOut: true })
    const timedOut = await resolveContributedPiPackage("latex-workbench/latex", {
      deps: { lookup: () => marked(), getPluginConfig: () => ({}) },
    })
    expect(timedOut.prepareState).toBe("unknown")
  })
})

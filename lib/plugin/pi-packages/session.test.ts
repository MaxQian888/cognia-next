import type { PluginPiPackageDef } from "@/types/plugin/plugin-pi-package"
import type { ContributedPiPackage } from "./registry"
import { PiPackageResolutionError } from "./resolve"
import {
  piScopeLoadingPackage,
  piScopesLoadedByPolicy,
  piSettingsEntryLoadsExtensions,
  resolveHostedPiPackages,
  type PiSettingsForSession,
} from "./session"

const ROOT_A = "/data/plugins/latex-workbench"
const ROOT_B = "/data/plugins/diagrams"

function contributed(
  pluginId: string,
  root: string,
  def: Partial<PluginPiPackageDef>
): ContributedPiPackage {
  const full: PluginPiPackageDef = {
    id: "pkg",
    name: "Pkg",
    path: "pi",
    hostedSession: { extensions: ["pi/ext.ts"] },
    ...def,
  }
  return { def: full, installRoot: root, pluginId, ref: `${pluginId}/${full.id}` }
}

const registry: Record<string, ContributedPiPackage> = {
  "latex-workbench/latex": contributed("latex-workbench", ROOT_A, {
    id: "latex",
    minPiVersion: "0.86.0",
    hostedSession: {
      extensions: ["pi/latex.ts"],
      env: [{ name: "WORKSPACE", from: { workspace: true } }],
      tools: ["latex_compile"],
      controlsSession: true,
    },
  }),
  "diagrams/mermaid": contributed("diagrams", ROOT_B, { id: "mermaid" }),
  "diagrams/install-only": contributed("diagrams", ROOT_B, {
    id: "install-only",
    hostedSession: undefined,
  }),
}

const noSettings: PiSettingsForSession = {
  user: [],
  project: [],
  userBaseDir: "/home/me/.pi/agent",
  projectCwd: null,
}

const deps = {
  processesRunRemotely: () => false,
  readPiSettings: async () => noSettings,
  resolveDeps: {
    lookup: (ref: string) => registry[ref],
    getPluginConfig: () => ({}),
    markerExists: async () => true,
  },
}

describe("resolveHostedPiPackages", () => {
  it("resolves every reference in order, deduplicated, with readable plugin roots", async () => {
    const resolved = await resolveHostedPiPackages(
      ["latex-workbench/latex", "diagrams/mermaid", "latex-workbench/latex"],
      { cwd: "/work", extensionPolicy: "global" },
      deps
    )
    expect(resolved).toEqual([
      {
        ref: "latex-workbench/latex",
        extensions: [`${ROOT_A}/pi/latex.ts`],
        env: { COGNIA_PIPKG_WORKSPACE: "/work" },
        tools: ["latex_compile"],
        readableRoots: [ROOT_A],
        controlsSession: true,
        minPiVersion: "0.86.0",
      },
      {
        ref: "diagrams/mermaid",
        extensions: [`${ROOT_B}/pi/ext.ts`],
        env: {},
        tools: [],
        readableRoots: [ROOT_B],
        controlsSession: false,
      },
    ])
  })

  it("returns nothing for no references without consulting the transport", async () => {
    const processesRunRemotely = jest.fn(() => true)
    expect(
      await resolveHostedPiPackages(
        [],
        { extensionPolicy: "isolated" },
        {
          ...deps,
          processesRunRemotely,
        }
      )
    ).toEqual([])
    expect(processesRunRemotely).not.toHaveBeenCalled()
  })

  it("fails the whole start on any unusable reference instead of skipping it", async () => {
    await expect(
      resolveHostedPiPackages(
        ["diagrams/mermaid", "diagrams/install-only"],
        { cwd: "/w", extensionPolicy: "isolated" },
        deps
      )
    ).rejects.toMatchObject({ code: "not-hosted", ref: "diagrams/install-only" })
    await expect(
      resolveHostedPiPackages(["gone/pkg"], { cwd: "/w", extensionPolicy: "isolated" }, deps)
    ).rejects.toBeInstanceOf(PiPackageResolutionError)
  })

  it("refuses when processes run on a paired host", async () => {
    await expect(
      resolveHostedPiPackages(
        ["diagrams/mermaid"],
        { cwd: "/w", extensionPolicy: "isolated" },
        {
          ...deps,
          processesRunRemotely: () => true,
        }
      )
    ).rejects.toMatchObject({ code: "not-on-disk" })
  })
})

describe("double-load detection (installed in Pi AND opted into a hosted session)", () => {
  // A Cognia wrapper outside the package dir, over an installed `vendor/` package.
  const WRAPPED = contributed("latex-workbench", ROOT_A, {
    id: "wrapped",
    path: "vendor",
    hostedSession: { extensions: ["pi/cognia-workbench.ts"] },
  })
  // A hosted extension that IS a file of the package itself.
  const INSIDE = contributed("latex-workbench", ROOT_A, {
    id: "inside",
    path: "vendor",
    hostedSession: { extensions: ["vendor/extensions/index.ts"] },
  })
  const table: Record<string, ContributedPiPackage> = {
    [WRAPPED.ref]: WRAPPED,
    [INSIDE.ref]: INSIDE,
  }
  const withSettings = (settings: Partial<PiSettingsForSession>) => ({
    processesRunRemotely: () => false,
    readPiSettings: jest.fn(async () => ({ ...noSettings, ...settings })),
    resolveDeps: {
      lookup: (ref: string) => table[ref],
      getPluginConfig: () => ({}),
      markerExists: async () => true,
    },
  })

  it("refuses a wrapper when Pi also autoloads the installed package (global, user scope)", async () => {
    await expect(
      resolveHostedPiPackages(
        [WRAPPED.ref],
        { cwd: "/w", extensionPolicy: "global" },
        withSettings({ user: [`${ROOT_A}/vendor`] })
      )
    ).rejects.toMatchObject({ code: "double-load", ref: WRAPPED.ref })
  })

  it("keeps -e when the hosted extension is inside the package (Pi dedupes by canonical path)", async () => {
    const [pkg] = await resolveHostedPiPackages(
      [INSIDE.ref],
      { cwd: "/w", extensionPolicy: "global" },
      withSettings({ user: [`${ROOT_A}/vendor`] })
    )
    expect(pkg.extensions).toEqual([`${ROOT_A}/vendor/extensions/index.ts`])
  })

  it("never checks settings under the isolated policy", async () => {
    const deps2 = withSettings({ user: [`${ROOT_A}/vendor`] })
    await resolveHostedPiPackages([WRAPPED.ref], { cwd: "/w", extensionPolicy: "isolated" }, deps2)
    expect(deps2.readPiSettings).not.toHaveBeenCalled()
  })

  it("ignores project scope under global, but not under trusted-project", async () => {
    const projectInstall = { project: [`${ROOT_A}/vendor`], projectCwd: "/w" }
    await expect(
      resolveHostedPiPackages(
        [WRAPPED.ref],
        { cwd: "/w", extensionPolicy: "global" },
        withSettings(projectInstall)
      )
    ).resolves.toHaveLength(1)
    await expect(
      resolveHostedPiPackages(
        [WRAPPED.ref],
        { cwd: "/w", extensionPolicy: "trusted-project" },
        withSettings(projectInstall)
      )
    ).rejects.toMatchObject({ code: "double-load" })
  })

  it("does not count an inert entry, and skips the user scope it cannot see", async () => {
    await expect(
      resolveHostedPiPackages(
        [WRAPPED.ref],
        { cwd: "/w", extensionPolicy: "global" },
        withSettings({ user: [{ source: `${ROOT_A}/vendor`, autoload: false }] })
      )
    ).resolves.toHaveLength(1)
    await expect(
      resolveHostedPiPackages(
        [WRAPPED.ref],
        { cwd: "/w", extensionPolicy: "global", piAgentDirOverride: "/task/pi" },
        withSettings({ user: [`${ROOT_A}/vendor`] })
      )
    ).resolves.toHaveLength(1)
  })

  it("proceeds when Pi's settings cannot be read", async () => {
    const deps3 = {
      ...withSettings({}),
      readPiSettings: jest.fn(async () => {
        throw new Error("unreadable")
      }),
    }
    await expect(
      resolveHostedPiPackages([WRAPPED.ref], { cwd: "/w", extensionPolicy: "global" }, deps3)
    ).resolves.toHaveLength(1)
  })

  it("matches relative user-scope specs against the agent dir", () => {
    expect(
      piScopeLoadingPackage(
        `${ROOT_A}/vendor`,
        { ...noSettings, userBaseDir: "/data/x", user: ["../plugins/latex-workbench/vendor"] },
        ["user"]
      )
    ).toBe("user")
  })

  it("classifies settings entries and policies", () => {
    expect(piSettingsEntryLoadsExtensions("npm:x")).toBe(true)
    expect(piSettingsEntryLoadsExtensions({ source: "x" })).toBe(true)
    expect(piSettingsEntryLoadsExtensions({ source: "x", autoload: false })).toBe(false)
    expect(piSettingsEntryLoadsExtensions({ source: "x", extensions: [] })).toBe(false)
    expect(
      piSettingsEntryLoadsExtensions({ source: "x", autoload: false, extensions: ["a.ts"] })
    ).toBe(true)
    expect(piScopesLoadedByPolicy("isolated", { userScopeVisible: true })).toEqual([])
    expect(piScopesLoadedByPolicy("global", { userScopeVisible: true })).toEqual(["user"])
    expect(piScopesLoadedByPolicy("trusted-project", { userScopeVisible: true })).toEqual([
      "user",
      "project",
    ])
    expect(piScopesLoadedByPolicy("trusted-project", { userScopeVisible: false })).toEqual([
      "project",
    ])
  })
})

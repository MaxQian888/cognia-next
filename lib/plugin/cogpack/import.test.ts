import type { PluginRow } from "@/lib/db/plugin-types"
import type { CogpackInstallRow, CogsetMember, CogsetRow } from "@/types/plugin/plugin-cogset"
import type { PluginManifest } from "@/types/plugin"

import {
  applyCogpackImport,
  CogpackRefusedError,
  planCogpackImport,
  type CogpackImportApplyDeps,
  type CogpackImportPlanDeps,
} from "./import"
import { exportCogpack, inspectCogpack } from "./package"
import type { MemberResolution } from "./resolvers"

const SHA = "0123456789abcdef0123456789abcdef01234567"
const text = (value: string) => new TextEncoder().encode(value)

async function cogpackBytes() {
  return (
    await exportCogpack({
      id: "deep-writer",
      version: "2.0.0",
      name: "Deep writer",
      description: "Long form",
      minHostVersion: "0.1.0",
      members: [
        {
          id: "same",
          name: "Same",
          version: "1.0.0",
          optional: false,
          source: { kind: "builtin" },
        },
        {
          id: "older",
          name: "Older",
          version: "2.0.0",
          optional: false,
          source: { kind: "github", owner: "acme", repo: "older", commit: SHA },
          config: { mode: "fast" },
          secretFields: ["token"],
        },
        {
          id: "fresh",
          name: "Fresh",
          version: "1.0.0",
          optional: true,
          source: { kind: "embedded" },
        },
        {
          id: "shipped",
          name: "Shipped",
          version: "1.0.0",
          optional: false,
          source: { kind: "builtin" },
        },
        {
          id: "wasm-git",
          name: "Wasm git",
          version: "1.0.0",
          optional: false,
          source: { kind: "git", url: "https://git.example/w.git", commit: SHA },
        },
      ],
      embedded: new Map([["fresh", [{ path: "plugin.json", bytes: text('{"id":"fresh"}') }]]]),
    })
  ).bytes
}

function row(id: string, version: string, extra: Partial<PluginRow> = {}): PluginRow {
  return {
    id,
    name: id,
    version,
    status: "installed",
    source: "local",
    type: "frontend",
    enabled: true,
    capabilities: [],
    path: `/plugins/${id}`,
    manifest: { id },
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }
}

const installers: Record<string, jest.Mock> = {}

function planDeps(overrides: Partial<CogpackImportPlanDeps> = {}): CogpackImportPlanDeps {
  const resolutions: Record<string, MemberResolution> = {
    same: { manifest: { id: "same" } as PluginManifest },
    older: {
      manifest: {
        id: "older",
        permissions: ["network:fetch"],
        dependencies: { "not-here": "^1.0.0", "too-old": "^2.0.0" },
        configSchema: { properties: { token: { type: "string", secret: true } } },
      } as unknown as PluginManifest,
      install: (installers.older = jest.fn(async () => ({}))),
    },
    fresh: {
      manifest: {
        id: "fresh",
        type: "wasm",
        permissions: ["clipboard:read"],
      } as unknown as PluginManifest,
      install: (installers.fresh = jest.fn(async () => ({}))),
    },
    shipped: { unavailable: { reason: "builtin-missing" } },
    "wasm-git": {
      install: (installers["wasm-git"] = jest.fn(async () => ({
        grantToReview: { manifest: { id: "wasm-git" } as PluginManifest },
      }))),
    },
  }
  return {
    inspect: inspectCogpack,
    resolveTrust: async () => ({ trust: "unsigned" }),
    resolveMember: async (member) => resolutions[member.id],
    listInstalled: async () => [
      row("same", "1.0.0"),
      row("older", "1.0.0"),
      row("too-old", "1.5.0"),
      row("games", "1.0.0"),
    ],
    getState: async () => ({ id: "host", alwaysOn: [], updatedAt: 1 }),
    isBlocked: () => false,
    detectConflicts: async (pluginId) =>
      pluginId === "older"
        ? {
            pluginId,
            reasons: [
              { severity: "high", message: "alreadyInstalled:1.0.0" },
              { severity: "medium", message: "command:clash" },
            ],
          }
        : null,
    missingBinaries: async (manifest) =>
      manifest.id === "older" ? [{ name: "rg", minVersion: "13.0.0" }] : [],
    listPreviousInstalls: async () => [],
    getCogset: async () => undefined,
    appVersion: "0.4.0",
    ...overrides,
  }
}

describe("planCogpackImport", () => {
  it("classifies members and gathers what the review shows", async () => {
    const plan = await planCogpackImport(await cogpackBytes(), planDeps())
    const byId = Object.fromEntries(plan.members.map((m) => [m.member.id, m]))
    expect(byId.same).toMatchObject({ status: "same", installByDefault: false, permissions: [] })
    expect(byId.older).toMatchObject({
      status: "different-version",
      installedVersion: "1.0.0",
      installByDefault: true,
      permissions: ["network:fetch"],
      missingBinaries: [{ name: "rg", minVersion: "13.0.0" }],
      conflicts: [{ severity: "medium", message: "command:clash" }],
      secretFields: ["token"],
    })
    expect(byId.fresh).toMatchObject({ status: "new", installByDefault: true })
    expect(byId.shipped).toMatchObject({ status: "unavailable", installByDefault: false })
    expect(byId["wasm-git"]).toMatchObject({ status: "new", reviewAfterInstall: true })
    expect(plan.missingDependencies).toEqual([
      { pluginId: "older", dependencyId: "not-here", constraint: "^1.0.0" },
      {
        pluginId: "older",
        dependencyId: "too-old",
        constraint: "^2.0.0",
        installedVersion: "1.5.0",
      },
    ])
    expect(plan.disabledOnActivation.sort()).toEqual(["games", "too-old"])
    expect(plan.compatibility).toEqual({
      minHostVersion: "0.1.0",
      hostVersion: "0.4.0",
      satisfied: true,
    })
    expect(plan.update).toBeUndefined()
  })

  it("flags an app older than the cogpack needs", async () => {
    const plan = await planCogpackImport(await cogpackBytes(), planDeps({ appVersion: "0.0.9" }))
    expect(plan.compatibility.satisfied).toBe(false)
  })

  it("offers to update the cogset an earlier import created", async () => {
    const bytes = await cogpackBytes()
    const previous = (await inspectCogpack(bytes)).manifest
    const cogset: CogsetRow = {
      id: "c1",
      name: "Deep writer",
      members: [{ pluginId: "same", expectedVersion: "1.0.0" }],
      source: {
        kind: "cogpack",
        cogpackId: "deep-writer",
        version: "1.0.0",
        fingerprint: "f",
        installId: "i1",
      },
      createdAt: 1,
      updatedAt: 1,
    }
    const install = { id: "i1", cogsetId: "c1", manifest: previous } as CogpackInstallRow
    const plan = await planCogpackImport(
      bytes,
      planDeps({
        listPreviousInstalls: async () => [install],
        getCogset: async (id) => (id === "c1" ? cogset : undefined),
      })
    )
    expect(plan.update?.cogset.id).toBe("c1")
    expect(plan.update?.entries.length).toBeGreaterThan(0)
  })
})

function applyDeps() {
  const created: Array<{ name: string; members: CogsetMember[]; source: CogsetRow["source"] }> = []
  const updated: Array<{ id: string; patch: unknown }> = []
  const installs: CogpackInstallRow[] = []
  const deps: CogpackImportApplyDeps & {
    rescan: jest.Mock
    applyConfig: jest.Mock
    trustSigner: jest.Mock
  } = {
    rescan: jest.fn(async () => undefined),
    getPlugin: async (id) =>
      id === "older" ? row("older", "2.0.0", { config: { mode: "slow" } }) : undefined,
    applyConfig: jest.fn(async () => undefined),
    createCogset: async (draft) => {
      created.push(draft)
      return { id: "new-cogset", createdAt: 1, updatedAt: 1, ...draft }
    },
    updateCogset: async (id, patch) => {
      updated.push({ id, patch })
    },
    putInstall: async (installRow) => {
      installs.push(installRow)
    },
    trustSigner: jest.fn(async () => undefined),
    defaultGrant: (manifest) => ({
      pluginId: manifest.id,
      grantedPermissions: ["clipboard:read"],
      grantedPreopens: [],
    }),
    newInstallId: () => "install-1",
    now: () => 99,
  }
  return { deps, created, updated, installs }
}

describe("applyCogpackImport", () => {
  it("installs what was chosen, writes secrets to the plugin, and creates the cogset", async () => {
    const plan = await planCogpackImport(await cogpackBytes(), planDeps())
    const a = applyDeps()
    const progress: number[] = []
    installers.fresh.mockRejectedValueOnce(new Error("disk full"))
    const result = await applyCogpackImport(
      plan,
      {
        install: new Set(["older", "fresh", "wasm-git"]),
        secrets: { older: { token: "s3cret" }, fresh: { token: "" } },
        trustSigner: false,
        mode: "new",
        useNext: new Set(),
      },
      { deps: a.deps, onProgress: (p) => progress.push(p.done) }
    )
    expect(progress).toEqual([0, 1, 2, 3])
    expect(installers.older).toHaveBeenCalledWith({
      viaCogpack: {
        cogpackId: "deep-writer",
        version: "2.0.0",
        fingerprint: plan.inspected.fingerprint,
      },
    })
    // A WASM member is installed with the grant the review showed.
    expect(installers.fresh.mock.calls[0][0].grantDecision).toEqual({
      pluginId: "fresh",
      grantedPermissions: ["clipboard:read"],
      grantedPreopens: [],
    })
    expect(result.installed).toEqual(["older", "wasm-git"])
    expect(result.failed).toEqual([{ pluginId: "fresh", message: "disk full" }])
    expect(result.grantsToReview).toEqual([{ manifest: { id: "wasm-git" } }])
    expect(a.deps.rescan).toHaveBeenCalledTimes(1)
    expect(a.deps.applyConfig).toHaveBeenCalledWith("older", { mode: "slow", token: "s3cret" })
    expect(a.deps.applyConfig).toHaveBeenCalledTimes(1)
    expect(result.missing).toEqual([
      { pluginId: "fresh", reason: "install-failed" },
      { pluginId: "shipped", reason: "builtin-missing" },
    ])
    expect(a.created[0]).toMatchObject({
      name: "Deep writer",
      description: "Long form",
      source: {
        kind: "cogpack",
        cogpackId: "deep-writer",
        version: "2.0.0",
        installId: "install-1",
      },
    })
    // The secret never lands in the cogset.
    expect(a.created[0].members.find((m) => m.pluginId === "older")).toEqual({
      pluginId: "older",
      expectedVersion: "2.0.0",
      config: { mode: "fast" },
    })
    expect(a.installs[0]).toMatchObject({
      id: "install-1",
      cogsetId: "new-cogset",
      trust: "unsigned",
      installedAt: 99,
    })
    expect(result.cogsetId).toBe("new-cogset")
  })

  it("pins the kept version when the user keeps their own, and lists skipped members", async () => {
    const plan = await planCogpackImport(await cogpackBytes(), planDeps())
    const a = applyDeps()
    const result = await applyCogpackImport(
      plan,
      { install: new Set(), secrets: {}, trustSigner: false, mode: "new", useNext: new Set() },
      { deps: a.deps }
    )
    expect(a.deps.rescan).not.toHaveBeenCalled()
    expect(a.created[0].members.find((m) => m.pluginId === "older")?.expectedVersion).toBe("1.0.0")
    expect(result.missing.map((m) => m.pluginId).sort()).toEqual(["fresh", "shipped", "wasm-git"])
  })

  it("refuses what the policy refuses, and an update with nothing to update", async () => {
    const refused = await planCogpackImport(
      await cogpackBytes(),
      planDeps({
        resolveTrust: async () => ({ trust: "unsigned", refusedBy: "signature-required" }),
      })
    )
    const choices = {
      install: new Set<string>(),
      secrets: {},
      trustSigner: false,
      mode: "new" as const,
      useNext: new Set<string>(),
    }
    await expect(
      applyCogpackImport(refused, choices, { deps: applyDeps().deps })
    ).rejects.toBeInstanceOf(CogpackRefusedError)
    const plan = await planCogpackImport(await cogpackBytes(), planDeps())
    await expect(
      applyCogpackImport(plan, { ...choices, mode: "update" }, { deps: applyDeps().deps })
    ).rejects.toThrow("nothing to update")
  })

  it("updates the earlier cogset and trusts the signer when asked", async () => {
    const bytes = await cogpackBytes()
    const previous = (await inspectCogpack(bytes)).manifest
    const cogset: CogsetRow = {
      id: "c1",
      name: "Deep writer",
      members: [],
      source: { kind: "manual" },
      createdAt: 1,
      updatedAt: 1,
    }
    const plan = await planCogpackImport(
      bytes,
      planDeps({
        listPreviousInstalls: async () => [
          { id: "i1", cogsetId: "c1", manifest: previous } as CogpackInstallRow,
        ],
        getCogset: async () => cogset,
      })
    )
    plan.inspected.manifest.signature = {
      algorithm: "ed25519",
      publisher: "Ada",
      publicKey: "K",
      signature: "S",
    }
    const a = applyDeps()
    const result = await applyCogpackImport(
      plan,
      { install: new Set(), secrets: {}, trustSigner: true, mode: "update", useNext: new Set() },
      { deps: a.deps }
    )
    expect(result.cogsetId).toBe("c1")
    expect(a.updated[0]).toMatchObject({
      id: "c1",
      patch: { source: { kind: "cogpack", installId: "install-1" } },
    })
    expect(a.deps.trustSigner).toHaveBeenCalledWith(plan.inspected.manifest.signature)
    expect(a.installs[0]).toMatchObject({ signerPublicKey: "K", signerName: "Ada" })
  })
})

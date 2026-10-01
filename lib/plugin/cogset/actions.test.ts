const activateCogset = jest.fn(async (id: string) => ({ cogsetId: id }))
const setPluginEnabledForHost = jest.fn(async (..._args: unknown[]) => ({
  ok: true,
  queued: false,
}))
const queueCogsetActivation = jest.fn(async (_id: string) => undefined)
const followerEvaluate = jest.fn(async () => undefined)
let mirrored = false
const projectState = {
  activeProjectId: null as string | null,
  projects: [] as Array<{ id: string; pluginCogsetId?: string }>,
  updateProject: jest.fn(),
}

jest.mock("./reconcile", () => ({
  activateCogset: (id: string) => activateCogset(id),
  COGSET_TOGGLE_REASON: "cogset",
}))
jest.mock("./remote", () => ({ queueCogsetActivation: (id: string) => queueCogsetActivation(id) }))
jest.mock("./follower-registry", () => ({
  getActiveCogsetFollower: () => ({ evaluate: followerEvaluate }),
}))
jest.mock("@/lib/plugin/core/set-plugin-enabled-for-host", () => ({
  isMirroredPluginClient: () => mirrored,
  setPluginEnabledForHost: (...args: unknown[]) => setPluginEnabledForHost(...args),
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => projectState },
}))

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createCogset, getCogset, getCogsetState, updateCogsetState } from "@/lib/db/plugin-cogsets"
import { upsertPlugin } from "@/lib/db/plugins"
import { putInstallOrigin } from "@/lib/db/plugin-install-origins"
import { useCogsetSessionStore } from "@/stores/plugins/cogset-session-store"

import {
  CogsetInUseError,
  CogsetMirrorError,
  createCogsetFromPlugins,
  listPluginsOnlyIn,
  removeCogset,
  retryAppliedCogset,
  setGlobalCogset,
  setPluginAlwaysOn,
  setWorkspaceCogset,
  switchCogset,
  switchCogsetFromRemote,
} from "./actions"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  jest.clearAllMocks()
  mirrored = false
  projectState.activeProjectId = null
  projectState.projects = []
  useCogsetSessionStore.getState().clearOverride()
})
afterAll(dbFixture.dispose)

async function plugin(id: string, enabled: boolean, extra: Record<string, unknown> = {}) {
  await upsertPlugin({
    id,
    name: id,
    version: "1.0.0",
    type: "frontend",
    source: "local",
    path: `/plugins/${id}`,
    manifest: { id, configSchema: { properties: { token: { type: "string", secret: true } } } },
    enabled,
    ...extra,
  })
}

const manual = { kind: "manual" as const }

describe("switchCogset", () => {
  it("sets the global choice and activates when no workspace binding is in force", async () => {
    const target = await createCogset({ name: "Writing", members: [], source: manual })
    await expect(switchCogset(target.id)).resolves.toEqual({
      queued: false,
      result: { cogsetId: target.id },
    })
    expect((await getCogsetState()).globalCogsetId).toBe(target.id)
    expect(activateCogset).toHaveBeenCalledWith(target.id)
  })

  it("records a session override while the workspace binds another cogset", async () => {
    const bound = await createCogset({ name: "Bound", members: [], source: manual })
    const other = await createCogset({ name: "Other", members: [], source: manual })
    projectState.activeProjectId = "p1"
    projectState.projects = [{ id: "p1", pluginCogsetId: bound.id }]

    await switchCogset(other.id)
    expect(useCogsetSessionStore.getState().overrideCogsetId).toBe(other.id)
    expect((await getCogsetState()).globalCogsetId).toBeUndefined()

    await switchCogset(bound.id)
    expect(useCogsetSessionStore.getState().overrideCogsetId).toBeUndefined()
  })

  it("queues the switch on a mirrored client", async () => {
    mirrored = true
    await expect(switchCogset("anything")).resolves.toEqual({ queued: true })
    expect(queueCogsetActivation).toHaveBeenCalledWith("anything")
    expect(activateCogset).not.toHaveBeenCalled()
  })

  it("refuses a cogset that does not exist", async () => {
    await expect(switchCogset("nope")).rejects.toThrow("Cogset nope does not exist")
  })

  it("a remote switch records the scope and lets the follower apply it", async () => {
    const target = await createCogset({ name: "Remote", members: [], source: manual })
    await switchCogsetFromRemote(target.id)
    expect((await getCogsetState()).globalCogsetId).toBe(target.id)
    expect(followerEvaluate).toHaveBeenCalled()
    expect(activateCogset).not.toHaveBeenCalled()
  })
})

describe("host-only edits", () => {
  it("refuse on a mirrored client", async () => {
    mirrored = true
    await expect(
      createCogsetFromPlugins({ name: "x", pluginIds: [], source: { kind: "manual" } })
    ).rejects.toBeInstanceOf(CogsetMirrorError)
    await expect(setPluginAlwaysOn("x", true)).rejects.toBeInstanceOf(CogsetMirrorError)
    await expect(retryAppliedCogset()).rejects.toBeInstanceOf(CogsetMirrorError)
  })

  it("retries the applied cogset, or does nothing without one", async () => {
    await expect(retryAppliedCogset()).resolves.toBeNull()
    await updateCogsetState({ appliedCogsetId: "a" })
    await retryAppliedCogset()
    expect(activateCogset).toHaveBeenCalledWith("a")
  })

  it("sets the global cogset and binds a workspace, refusing unknown cogsets", async () => {
    const row = await createCogset({ name: "A", members: [], source: manual })
    await setGlobalCogset(row.id)
    expect((await getCogsetState()).globalCogsetId).toBe(row.id)
    await setWorkspaceCogset("p1", row.id)
    expect(projectState.updateProject).toHaveBeenCalledWith("p1", { pluginCogsetId: row.id })
    await setWorkspaceCogset("p1", undefined)
    expect(projectState.updateProject).toHaveBeenLastCalledWith("p1", { pluginCogsetId: undefined })
    await expect(setWorkspaceCogset("p1", "nope")).rejects.toThrow("does not exist")
    await expect(setGlobalCogset("nope")).rejects.toThrow("does not exist")
  })

  it("creates a cogset from chosen plugins, keeping unknown ids as members", async () => {
    await plugin("gh", false, { config: { org: "acme", token: "t" } })
    const row = await createCogsetFromPlugins({
      name: "Preset",
      pluginIds: ["gh", "not-yet-installed"],
      source: { kind: "preset", presetId: "repo:starter", presetName: "Starter" },
    })
    expect(row.members).toEqual([
      { pluginId: "gh", config: { org: "acme" } },
      { pluginId: "not-yet-installed" },
    ])
  })
})

describe("always-on", () => {
  it("turning it on enables the plugin and removes it from the applied cogset", async () => {
    await plugin("core", false)
    const applied = await createCogset({
      name: "A",
      members: [{ pluginId: "core" }],
      source: manual,
    })
    await updateCogsetState({ appliedCogsetId: applied.id })
    await setPluginAlwaysOn("core", true)
    expect((await getCogsetState()).alwaysOn).toEqual(["core"])
    expect((await getCogset(applied.id))!.members).toEqual([])
    expect(setPluginEnabledForHost).toHaveBeenCalledWith("core", true, "cogset")
  })

  it("turning it off keeps a running plugin as a member of the applied cogset", async () => {
    await plugin("core", true)
    const applied = await createCogset({ name: "A", members: [], source: manual })
    await updateCogsetState({ appliedCogsetId: applied.id, alwaysOn: ["core"] })
    await setPluginAlwaysOn("core", false)
    expect((await getCogsetState()).alwaysOn).toEqual([])
    expect((await getCogset(applied.id))!.members).toEqual([{ pluginId: "core" }])
  })

  it("surfaces a failed enable", async () => {
    await plugin("core", false)
    setPluginEnabledForHost.mockResolvedValueOnce({
      ok: false,
      queued: false,
      error: "nope",
    } as never)
    await expect(setPluginAlwaysOn("core", true)).rejects.toThrow("nope")
  })
})

describe("removing a cogset", () => {
  it("refuses the applied and the global cogset", async () => {
    const a = await createCogset({ name: "A", members: [], source: manual })
    const g = await createCogset({ name: "G", members: [], source: manual })
    await updateCogsetState({ appliedCogsetId: a.id, globalCogsetId: g.id })
    await expect(removeCogset(a.id)).rejects.toEqual(new CogsetInUseError("applied"))
    await expect(removeCogset(g.id)).rejects.toEqual(new CogsetInUseError("global"))
  })

  it("deletes another cogset and clears a session override pointing at it", async () => {
    const doomed = await createCogset({ name: "D", members: [], source: manual })
    useCogsetSessionStore.getState().setOverride(doomed.id)
    await removeCogset(doomed.id)
    expect(await getCogset(doomed.id)).toBeUndefined()
    expect(useCogsetSessionStore.getState().overrideCogsetId).toBeUndefined()
  })

  it("lists plugins nothing else uses, excluding built-ins", async () => {
    await plugin("only-here", true)
    await plugin("shared", true)
    await plugin("pinned", true)
    await plugin("bundled", true)
    await putInstallOrigin({
      pluginId: "bundled",
      version: "1.0.0",
      origin: { kind: "builtin" },
      recordedAt: 1,
    })
    await upsertPlugin({
      id: "shipped",
      name: "shipped",
      version: "1.0.0",
      type: "frontend",
      source: "builtin",
      path: "builtin://shipped",
      manifest: { id: "shipped" },
    })
    const target = await createCogset({
      name: "T",
      members: ["only-here", "shared", "pinned", "bundled", "shipped", "gone"].map((pluginId) => ({
        pluginId,
      })),
      source: manual,
    })
    await createCogset({ name: "Other", members: [{ pluginId: "shared" }], source: manual })
    await updateCogsetState({ alwaysOn: ["pinned"] })
    await expect(listPluginsOnlyIn(target.id)).resolves.toEqual(["only-here"])
    await expect(listPluginsOnlyIn("missing")).resolves.toEqual([])
  })
})

/**
 * @jest-environment node
 *
 * Exercises the DEFAULT seams of the plugin controller (the lazy real-manager
 * wiring) by mocking the leaf modules they import, so the handler defaults run
 * end-to-end without a live PluginManager.
 */
import type { TuiAction } from "../state/types"

const managerCalls: string[] = []
const fakeManager = {
  setPluginIntent: jest.fn(
    async (id: string, intent: "enabled" | "disabled") =>
      void managerCalls.push(`intent:${intent}:${id}`)
  ),
  enablePlugin: jest.fn(async (id: string) => void managerCalls.push(`enable:${id}`)),
  disablePlugin: jest.fn(async (id: string) => void managerCalls.push(`disable:${id}`)),
  loadPlugin: jest.fn(async (id: string) => void managerCalls.push(`load:${id}`)),
  unloadPlugin: jest.fn(async (id: string) => void managerCalls.push(`unload:${id}`)),
  registerDiskPlugin: jest.fn(
    async (m: { id: string }) => void managerCalls.push(`register:${m.id}`)
  ),
}

jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => fakeManager,
}))

jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: {
    getState: () => ({
      plugins: {
        demo: {
          manifest: { id: "demo", name: "Demo", version: "1.0.0", type: "frontend", tools: [] },
          path: path.join(base.home, "plugins", "demo"),
          status: "enabled",
        },
      },
    }),
  },
}))

jest.mock("@/lib/plugin/package/github-source", () => ({
  parseGithubPluginRef: (ref: string) => ({ owner: "o", repo: "r", raw: ref }),
  fetchGithubPluginPreview: async () => ({
    manifest: { id: "demo", name: "Demo", version: "1.0.0", type: "frontend", permissions: [] },
  }),
}))

jest.mock("@/lib/plugin/package/github-marketplace", () => ({
  fetchAllSourceEntries: async () => ({
    entries: [
      {
        name: "Demo",
        description: "a demo",
        github: { owner: "o", repo: "r", ref: "main", subdir: "plugins/demo" },
      },
    ],
    errors: [],
  }),
}))

jest.mock("../../plugin/install", () => ({
  installFromGithubRef: async () => ({
    id: "demo",
    dir: path.join(base.home, "plugins", "demo"),
    manifest: { id: "demo", name: "Demo", version: "1.0.0", type: "frontend" },
  }),
}))

import os from "node:os"
import nodeFs from "node:fs"
import path from "node:path"
import {
  pluginList,
  pluginSetEnabled,
  pluginReload,
  pluginInstall,
  pluginUninstall,
  pluginMarketplace,
  pluginSourcesList,
  pluginSourcesAdd,
  pluginSourcesRemove,
  buildConsentSummary,
} from "./plugin-controller"
import type { PluginManifest } from "@/types/plugin"

function recorder() {
  const actions: TuiAction[] = []
  return { dispatch: (a: TuiAction) => actions.push(a), actions }
}

const base = {
  roots: ["/w"],
  home: "",
  getDisabled: () => new Set<string>(),
  recordOrigin: jest.fn(),
  removeOrigin: jest.fn(),
}

beforeEach(() => {
  managerCalls.length = 0
  base.home = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cognia-plugin-defaults-"))
})
afterEach(() => {
  nodeFs.rmSync(base.home, { recursive: true, force: true })
})

describe("controller default seams", () => {
  it("pluginList reads the manager store", async () => {
    const { dispatch, actions } = recorder()
    await pluginList({ ...base, dispatch })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "select", items: [{ id: "demo" }] },
    })
  })

  it("pluginSetEnabled flips the real manager on", async () => {
    const { dispatch } = recorder()
    await pluginSetEnabled("demo", true, { ...base, dispatch, setEnabled: () => {} })
    expect(managerCalls).toContain("intent:enabled:demo")
  })

  it("pluginSetEnabled flips the real manager off", async () => {
    const { dispatch } = recorder()
    await pluginSetEnabled("demo", false, { ...base, dispatch, setEnabled: () => {} })
    expect(managerCalls).toContain("intent:disabled:demo")
  })

  it("pluginReload runs the manager lifecycle", async () => {
    const { dispatch } = recorder()
    await pluginReload("demo", { ...base, dispatch })
    expect(managerCalls).toEqual(["disable:demo", "unload:demo", "load:demo", "enable:demo"])
  })

  it("pluginInstall phase 1 previews via the github source", async () => {
    const { dispatch, actions } = recorder()
    await pluginInstall("o/r", { ...base, dispatch })
    expect(actions[0]).toMatchObject({ overlay: { kind: "confirm" } })
  })

  it("pluginInstall phase 2 downloads + registers via the manager", async () => {
    const { dispatch, actions } = recorder()
    await pluginInstall("o/r --confirmed", { ...base, dispatch })
    expect(managerCalls).toContain("register:demo")
    expect((actions[actions.length - 1] as { message: string }).message).toContain("Installed")
  })

  it("pluginUninstall resolves the dir from the store and unloads", async () => {
    const { dispatch, actions } = recorder()
    await pluginUninstall("demo", { ...base, dispatch })
    expect(managerCalls).toContain("unload:demo")
    expect((actions[actions.length - 1] as { message: string }).message).toContain("Uninstalled")
  })

  it("pluginUninstall errors when the plugin dir is unknown", async () => {
    const { dispatch, actions } = recorder()
    await pluginUninstall("ghost", { ...base, dispatch })
    expect((actions[0] as { message: string }).message).toMatch(/Uninstall failed.*unknown plugin/)
  })

  it("pluginMarketplace fetches catalog entries via the github marketplace", async () => {
    const { dispatch, actions } = recorder()
    await pluginMarketplace({ ...base, dispatch, getSources: () => ["o/r"] })
    expect(actions[actions.length - 1]).toMatchObject({
      overlay: {
        kind: "marketplace",
        entries: [{ name: "Demo", installRef: "o/r@main/plugins/demo" }],
      },
    })
  })

  it("source list/add/remove default to the real JSON store", () => {
    const home = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cognia-src-"))
    try {
      const a = recorder()
      pluginSourcesList({ roots: [], home, dispatch: a.dispatch })
      expect((a.actions[0] as { message: string }).message).toContain("No marketplace sources")

      const b = recorder()
      pluginSourcesAdd("owner/repo", { roots: [], home, dispatch: b.dispatch })
      const file = path.join(home, ".cognia", "plugin-marketplace-sources.json")
      expect(JSON.parse(nodeFs.readFileSync(file, "utf8")).sources).toEqual(["owner/repo"])

      const c = recorder()
      pluginSourcesList({ roots: [], home, dispatch: c.dispatch })
      expect((c.actions[0] as { message: string }).message).toContain("owner/repo")

      pluginSourcesRemove("owner/repo", { roots: [], home, dispatch: recorder().dispatch })
      expect(JSON.parse(nodeFs.readFileSync(file, "utf8")).sources).toEqual([])
    } finally {
      nodeFs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("buildConsentSummary falls back to id when name is absent and shows no network section", () => {
    const body = buildConsentSummary(
      { id: "x.y", version: "1.0.0", type: "frontend" } as unknown as PluginManifest,
      { ref: "o/r", alreadyInstalled: false }
    )
    expect(body).toContain("Install x.y?")
    expect(body).not.toContain("Network egress")
  })
})

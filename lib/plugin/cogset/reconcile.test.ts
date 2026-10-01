import type { CogsetRow, CogsetStateRow } from "@/types/plugin/plugin-cogset"

import type { InstalledPluginView } from "./plan"
import {
  activateCogset,
  cogsetActivationTarget,
  isCogsetReconciling,
  type CogsetReconcileDeps,
} from "./reconcile"

const secretSchema = {
  configSchema: { type: "object", properties: { token: { type: "string", secret: true } } },
}

function world(options: {
  cogsets: CogsetRow[]
  installed: InstalledPluginView[]
  state?: Partial<CogsetStateRow>
  failEnable?: string[]
  failConfig?: string[]
}) {
  const cogsets = new Map(options.cogsets.map((row) => [row.id, structuredClone(row)]))
  const installed = new Map(options.installed.map((plugin) => [plugin.id, structuredClone(plugin)]))
  let state: CogsetStateRow = { id: "host", alwaysOn: [], updatedAt: 0, ...options.state }
  const calls: string[] = []
  const deps: CogsetReconcileDeps = {
    getCogset: async (id) => structuredClone(cogsets.get(id)),
    updateCogset: async (id, patch) => {
      const row = cogsets.get(id)
      if (row) cogsets.set(id, { ...row, ...patch })
    },
    getState: async () => structuredClone(state),
    updateState: async (patch) => {
      state = { ...state, ...patch }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete (state as unknown as Record<string, unknown>)[key]
      }
      return state
    },
    listInstalled: async () => [...installed.values()].map((plugin) => structuredClone(plugin)),
    setEnabled: async (pluginId, next) => {
      calls.push(`${next ? "enable" : "disable"}:${pluginId}`)
      if (next && options.failEnable?.includes(pluginId)) return { ok: false, error: "boom" }
      installed.get(pluginId)!.enabled = next
      return { ok: true }
    },
    applyConfig: async (pluginId, config) => {
      calls.push(`config:${pluginId}`)
      if (options.failConfig?.includes(pluginId)) throw new Error("disk full")
      installed.get(pluginId)!.config = config
    },
    isBlocked: () => false,
    now: () => 100,
  }
  return { deps, cogsets, installed, calls, state: () => state }
}

const cogset = (id: string, members: CogsetRow["members"]): CogsetRow => ({
  id,
  name: id,
  members,
  source: { kind: "manual" },
  createdAt: 1,
  updatedAt: 1,
})

describe("activateCogset", () => {
  it("disables, applies config, then enables, and records the result", async () => {
    const w = world({
      cogsets: [cogset("writing", [{ pluginId: "pdf", config: { dpi: 300 } }])],
      installed: [
        { id: "pdf", version: "1.0.0", enabled: false, manifest: {}, config: { dpi: 72 } },
        { id: "games", version: "1.0.0", enabled: true, manifest: {} },
      ],
    })
    const progress: number[] = []
    const result = await activateCogset("writing", {
      deps: w.deps,
      onProgress: (p) => progress.push(p.done),
    })
    expect(w.calls).toEqual(["disable:games", "config:pdf", "enable:pdf"])
    expect(progress).toEqual([0, 1, 2, 3])
    expect(result.applied.status).toBe("applied")
    expect(w.cogsets.get("writing")!.lastApplied).toEqual(result.applied)
    expect(w.state()).toMatchObject({ appliedCogsetId: "writing", appliedAt: 100 })
  })

  it("saves the outgoing cogset's current config, without secrets, before switching", async () => {
    const w = world({
      cogsets: [cogset("dev", [{ pluginId: "gh" }]), cogset("writing", [{ pluginId: "pdf" }])],
      installed: [
        {
          id: "gh",
          version: "1.0.0",
          enabled: true,
          manifest: secretSchema,
          config: { org: "acme", token: "secret" },
        },
        { id: "pdf", version: "1.0.0", enabled: false, manifest: {} },
      ],
      state: { appliedCogsetId: "dev" },
    })
    await activateCogset("writing", { deps: w.deps })
    expect(w.cogsets.get("dev")!.members).toEqual([{ pluginId: "gh", config: { org: "acme" } }])
  })

  it("lets queued manual changes land before rewriting the outgoing cogset", async () => {
    const w = world({
      cogsets: [cogset("dev", [{ pluginId: "gh" }]), cogset("writing", [{ pluginId: "pdf" }])],
      installed: [
        { id: "gh", version: "1.0.0", enabled: true, manifest: {} },
        { id: "notes", version: "1.0.0", enabled: true, manifest: {} },
        { id: "pdf", version: "1.0.0", enabled: false, manifest: {} },
      ],
      state: { appliedCogsetId: "dev" },
    })
    // The write-through is still adding a manually enabled plugin to "dev".
    w.deps.settleWriteThrough = async () => {
      await w.deps.updateCogset("dev", { members: [{ pluginId: "gh" }, { pluginId: "notes" }] })
    }
    await activateCogset("writing", { deps: w.deps })
    expect(w.cogsets.get("dev")!.members).toEqual([{ pluginId: "gh" }, { pluginId: "notes" }])
  })

  it("marks the cogset partial and keeps going when one plugin fails", async () => {
    const w = world({
      cogsets: [
        cogset("s", [{ pluginId: "a" }, { pluginId: "b", config: { x: 1 } }, { pluginId: "c" }]),
      ],
      installed: [
        { id: "a", version: "1.0.0", enabled: false, manifest: {} },
        { id: "b", version: "1.0.0", enabled: false, manifest: {} },
        { id: "c", version: "1.0.0", enabled: false, manifest: {} },
      ],
      failEnable: ["a"],
      failConfig: ["b"],
    })
    const result = await activateCogset("s", { deps: w.deps })
    expect(result.applied.status).toBe("partial")
    expect(result.applied.outcomes).toEqual(
      expect.arrayContaining([
        { pluginId: "a", action: "enable", ok: false, reason: "enable-failed", message: "boom" },
        expect.objectContaining({
          pluginId: "b",
          action: "config",
          ok: false,
          reason: "config-failed",
        }),
        { pluginId: "c", action: "enable", ok: true },
      ])
    )
    expect(w.installed.get("c")!.enabled).toBe(true)
  })

  it("stays applied when only optional members are missing", async () => {
    const w = world({
      cogsets: [cogset("s", [{ pluginId: "gone", optional: true }, { pluginId: "a" }])],
      installed: [{ id: "a", version: "1.0.0", enabled: true, manifest: {} }],
    })
    const result = await activateCogset("s", { deps: w.deps })
    expect(result.applied.status).toBe("applied")
    expect(result.applied.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pluginId: "gone", reason: "not-installed", optional: true }),
        { pluginId: "a", action: "keep", ok: true },
      ])
    )
  })

  it("serializes activations and reports what it is doing", async () => {
    const w = world({
      cogsets: [cogset("a", [{ pluginId: "p" }]), cogset("b", [])],
      installed: [{ id: "p", version: "1.0.0", enabled: false, manifest: {} }],
    })
    let seenDuring: { reconciling: boolean; target: string | null } | undefined
    const slow = { ...w.deps }
    slow.setEnabled = async (id, next) => {
      seenDuring ??= { reconciling: isCogsetReconciling(), target: cogsetActivationTarget() }
      await new Promise((resolve) => setTimeout(resolve, 5))
      return w.deps.setEnabled(id, next)
    }
    const first = activateCogset("a", { deps: slow })
    const second = activateCogset("b", { deps: slow })
    await Promise.all([first, second])
    expect(w.calls).toEqual(["enable:p", "disable:p"])
    expect(seenDuring).toEqual({ reconciling: true, target: "a" })
    expect(isCogsetReconciling()).toBe(false)
    expect(cogsetActivationTarget()).toBeNull()
  })

  it("refuses a cogset that does not exist and keeps the queue usable", async () => {
    const w = world({ cogsets: [cogset("ok", [])], installed: [] })
    await expect(activateCogset("missing", { deps: w.deps })).rejects.toThrow(
      "Cogset missing does not exist"
    )
    await expect(activateCogset("ok", { deps: w.deps })).resolves.toMatchObject({ cogsetId: "ok" })
  })
})

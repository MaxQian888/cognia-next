import type { CogsetRow, CogsetStateRow } from "@/types/plugin/plugin-cogset"

import {
  DEFAULT_COGSET_NAME,
  ensureDefaultCogset,
  type BootstrapDefaultCogsetDeps,
} from "./bootstrap-default"

function deps(options: { state?: Partial<CogsetStateRow>; existing?: CogsetRow[] }) {
  let state: CogsetStateRow = { id: "host", alwaysOn: [], updatedAt: 0, ...options.state }
  const created: CogsetRow[] = []
  const d: BootstrapDefaultCogsetDeps = {
    getState: async () => state,
    updateState: async (patch) => (state = { ...state, ...patch }),
    listCogsets: async () => [...(options.existing ?? []), ...created],
    createCogset: async (draft) => {
      const row: CogsetRow = { id: "default-1", createdAt: 1, updatedAt: 1, ...draft }
      created.push(row)
      return row
    },
    listInstalled: async () => [
      {
        id: "gh",
        enabled: true,
        manifest: { configSchema: { properties: { token: { type: "string", secret: true } } } },
        config: { org: "acme", token: "t" },
      },
      { id: "pdf", enabled: true, manifest: {} },
      { id: "core", enabled: true, manifest: {} },
      { id: "idle", enabled: false, manifest: {} },
    ],
    now: () => 42,
  }
  return { d, created, state: () => state }
}

describe("ensureDefaultCogset", () => {
  it("creates Default from the enabled plugins and makes it global and applied", async () => {
    const t = deps({ state: { alwaysOn: ["core"] } })
    await expect(ensureDefaultCogset(t.d)).resolves.toBe(true)
    expect(t.created).toEqual([
      expect.objectContaining({
        name: DEFAULT_COGSET_NAME,
        source: { kind: "default" },
        members: [{ pluginId: "gh", config: { org: "acme" } }, { pluginId: "pdf" }],
      }),
    ])
    expect(t.state()).toMatchObject({
      globalCogsetId: "default-1",
      appliedCogsetId: "default-1",
      appliedAt: 42,
      defaultBootstrappedAt: 42,
    })
  })

  it("runs once", async () => {
    const t = deps({ state: { defaultBootstrappedAt: 1 } })
    await expect(ensureDefaultCogset(t.d)).resolves.toBe(false)
    expect(t.created).toEqual([])
  })

  it("only marks a host that already has cogsets as bootstrapped", async () => {
    const t = deps({
      existing: [
        {
          id: "mine",
          name: "Mine",
          members: [],
          source: { kind: "manual" },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    await expect(ensureDefaultCogset(t.d)).resolves.toBe(false)
    expect(t.created).toEqual([])
    expect(t.state()).toMatchObject({ defaultBootstrappedAt: 42 })
    expect(t.state().globalCogsetId).toBeUndefined()
  })
})

import type { PluginRow } from "@/lib/db/plugin-types"
import type { CogsetRow, PluginInstallOriginRecord } from "@/types/plugin/plugin-cogset"

import {
  exportCogsetPreview,
  previewCogsetExport,
  suggestCogpackId,
  type CogpackExportDeps,
} from "./export"
import { inspectCogpack } from "./package"

const SHA = "0123456789abcdef0123456789abcdef01234567"
const text = (value: string) => new TextEncoder().encode(value)

function row(id: string, overrides: Partial<PluginRow> = {}): PluginRow {
  return {
    id,
    name: id.toUpperCase(),
    version: "1.0.0",
    status: "installed",
    source: "local",
    type: "frontend",
    enabled: true,
    capabilities: [],
    path: `/plugins/${id}`,
    manifest: { id, configSchema: { properties: { token: { type: "string", secret: true } } } },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const cogset: CogsetRow = {
  id: "c",
  name: "Writing",
  members: [
    { pluginId: "gh-tools", config: { org: "acme", token: "leak" } },
    { pluginId: "notes", optional: true },
    { pluginId: "cognia-pdf" },
    { pluginId: "stale" },
    { pluginId: "vsx" },
    { pluginId: "gone" },
    { pluginId: "core" },
  ],
  source: { kind: "manual" },
  createdAt: 1,
  updatedAt: 1,
}

function deps(): CogpackExportDeps & { readTree: jest.Mock } {
  const rows: Record<string, PluginRow> = {
    "gh-tools": row("gh-tools", { config: { org: "old", token: "t" } }),
    notes: row("notes", { config: { folder: "notes", token: "t" }, licenseText: "MIT" }),
    "cognia-pdf": row("cognia-pdf", { path: "builtin://cognia-pdf", source: "builtin" }),
    stale: row("stale", { version: "2.0.0" }),
    vsx: row("vsx", { type: "vscode-extension" }),
    core: row("core"),
  }
  const origins: Record<string, PluginInstallOriginRecord> = {
    "gh-tools": {
      pluginId: "gh-tools",
      version: "1.0.0",
      origin: { kind: "github", owner: "acme", repo: "tools", commit: SHA },
      recordedAt: 1,
    },
    notes: {
      pluginId: "notes",
      version: "1.0.0",
      origin: { kind: "local", via: "directory" },
      recordedAt: 1,
    },
    stale: {
      pluginId: "stale",
      version: "1.0.0",
      origin: { kind: "github", owner: "acme", repo: "stale", commit: SHA },
      recordedAt: 1,
    },
    vsx: {
      pluginId: "vsx",
      version: "1.0.0",
      origin: { kind: "local", via: "vsix" },
      recordedAt: 1,
    },
  }
  return {
    getCogset: async (id) => (id === "c" ? cogset : undefined),
    getCogsetState: async () => ({ id: "host", alwaysOn: ["core"], updatedAt: 1 }),
    getPlugin: async (id) => rows[id],
    getInstallOrigin: async (id) => origins[id],
    readTree: jest.fn(async (id: string) => [
      { path: "plugin.json", bytes: text(`{"id":"${id}"}`) },
      { path: "dist/index.js", bytes: text("export {}") },
    ]),
    appVersion: "0.4.0",
  }
}

describe("previewCogsetExport", () => {
  it("references reproducible members, embeds the rest, and never carries secrets", async () => {
    const preview = await previewCogsetExport("c", deps())
    const byId = Object.fromEntries(preview.members.map((m) => [m.pluginId, m]))
    expect(byId["gh-tools"]).toMatchObject({
      source: { kind: "github", commit: SHA },
      config: { org: "acme" },
      secretFields: ["token"],
    })
    expect(byId.notes).toMatchObject({
      source: { kind: "embedded" },
      optional: true,
      config: { folder: "notes" },
      licenseText: "MIT",
    })
    expect(byId["cognia-pdf"].source).toEqual({ kind: "builtin" })
    // The origin describes 1.0.0 but 2.0.0 is installed: embed, never promise.
    expect(byId.stale.source).toEqual({ kind: "embedded" })
    expect(preview.unportable).toEqual([{ pluginId: "vsx", name: "VSX", reason: "vscode-local" }])
    expect(preview.missing).toEqual(["gone"])
    expect(preview.alwaysOnExcluded).toEqual(["core"])
  })

  it("refuses a cogset that does not exist", async () => {
    await expect(previewCogsetExport("nope", deps())).rejects.toThrow("does not exist")
  })
})

describe("exportCogsetPreview", () => {
  it("builds a cogpack that reads back with embedded files and without dropped config", async () => {
    const d = deps()
    const preview = await previewCogsetExport("c", d)
    const exported = await exportCogsetPreview(
      {
        preview,
        id: "deep-writer",
        version: "1.0.0",
        name: "Deep writer",
        withoutConfig: new Set(["notes"]),
      },
      d
    )
    expect(d.readTree.mock.calls.map((call) => call[0]).sort()).toEqual(["notes", "stale"])
    const inspected = await inspectCogpack(exported.bytes)
    expect(inspected.manifest.compatibility.minHostVersion).toBe("0.4.0")
    const notes = inspected.manifest.members.find((m) => m.id === "notes")!
    expect(notes.config).toBeUndefined()
    expect(notes.secretFields).toEqual(["token"])
    expect(new TextDecoder().decode(inspected.embedded.get("notes")!.get("dist/index.js"))).toBe(
      "export {}"
    )
    expect(inspected.manifest.members.find((m) => m.id === "gh-tools")!.config).toEqual({
      org: "acme",
    })
  })
})

describe("suggestCogpackId", () => {
  it("slugifies a name", () => {
    expect(suggestCogpackId("Deep Writer — v2!")).toBe("deep-writer-v2")
    expect(suggestCogpackId("写作")).toBe("cogpack")
  })
})

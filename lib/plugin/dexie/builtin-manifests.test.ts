import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import { listBuiltinPrebootManifests } from "@/lib/plugin/core/builtin-preboot-manifests"
import {
  DORMANT_BUILTIN_DEXIE_DECLARATIONS,
  getBuiltinPluginDexieManifests,
} from "./builtin-manifests"

const PLUGINS_ROOT = join(__dirname, "..", "..", "..", "plugins")

/** Every in-tree plugin whose plugin.json declares Dexie tables, read from disk. */
function pluginsDeclaringTables(): string[] {
  return readdirSync(PLUGINS_ROOT)
    .filter((name) => {
      try {
        return statSync(join(PLUGINS_ROOT, name)).isDirectory()
      } catch {
        return false
      }
    })
    .flatMap((dir) => {
      let raw: string
      try {
        raw = readFileSync(join(PLUGINS_ROOT, dir, "plugin.json"), "utf-8")
      } catch {
        return []
      }
      const manifest = JSON.parse(raw) as { id?: string; dexie?: { tables?: unknown[] } }
      return manifest.id && manifest.dexie?.tables?.length ? [manifest.id] : []
    })
    .sort()
}

it("exposes every built-in dynamic table without importing plugin implementations", () => {
  const manifests = getBuiltinPluginDexieManifests()

  expect([...manifests.keys()].sort()).toEqual([
    "sre-agent",
    "strix-security",
    "zhihu-content-pipeline",
  ])
  expect(manifests.get("zhihu-content-pipeline")?.tables.map((table) => table.name)).toEqual([
    "topics",
    "research",
    "drafts",
  ])
  expect(manifests.get("sre-agent")?.tables.map((table) => table.name)).toEqual(["incidents"])
})

it("applies the same tables plugin.json declares", () => {
  for (const [id, dexie] of getBuiltinPluginDexieManifests()) {
    const dir = readdirSync(PLUGINS_ROOT).find((name) => {
      try {
        const raw = readFileSync(join(PLUGINS_ROOT, name, "plugin.json"), "utf-8")
        return (JSON.parse(raw) as { id?: string }).id === id
      } catch {
        return false
      }
    })
    expect(dir).toBeDefined()
    const manifest = JSON.parse(readFileSync(join(PLUGINS_ROOT, dir!, "plugin.json"), "utf-8")) as {
      dexie?: unknown
    }
    expect(dexie).toEqual(manifest.dexie)
  }
})

/**
 * A plugin that declares tables but is missing from the snapshot boots with no
 * table applied, and its first `ctx.dexie.table(...)` throws a lookup error at
 * call time instead of anything failing at boot. That happens when a plugin
 * that is not a browser built-in (and so is not in the generated snapshot)
 * starts declaring tables, or when the snapshot was not regenerated.
 */
it("covers every in-tree plugin that declares tables", () => {
  const declared = pluginsDeclaringTables()
  expect(declared.length).toBeGreaterThan(0)

  const inSnapshot = [...listBuiltinPrebootManifests()]
    .filter(([, manifest]) => manifest.dexie?.tables?.length)
    .map(([id]) => id)
    .sort()
  expect(inSnapshot).toEqual(declared)

  const expected = declared.filter((id) => !(id in DORMANT_BUILTIN_DEXIE_DECLARATIONS))
  expect([...getBuiltinPluginDexieManifests().keys()].sort()).toEqual(expected)
})

it("lists only dormant declarations that still exist, each with a reason", () => {
  const declared = pluginsDeclaringTables()
  for (const [id, reason] of Object.entries(DORMANT_BUILTIN_DEXIE_DECLARATIONS)) {
    expect(declared).toContain(id)
    expect(reason.length).toBeGreaterThan(20)
  }
  expect(getBuiltinPluginDexieManifests().has("github-delivery")).toBe(false)
})

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import { getBuiltinPluginDexieManifests } from "./builtin-manifests"

const PLUGINS_ROOT = join(__dirname, "..", "..", "..", "plugins")

/** Every bundled plugin whose manifest declares Dexie tables, read from disk. */
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

/**
 * Plugins that declare tables and are deliberately NOT in the boot registry.
 * Each needs a reason, so the exclusion is a reviewed decision rather than the
 * accident this test exists to catch.
 */
const KNOWN_UNREGISTERED: Readonly<Record<string, string>> = Object.freeze({
  "github-delivery":
    "Declares four tables, but no code path in the plugin calls ctx.dexie — " +
    "nothing reads or writes them. Applying the schema at boot would create " +
    "four empty stores for a feature that is not wired yet. Pre-existing.",
})

/**
 * The registry is a hand-maintained list and the failure mode is quiet: a
 * plugin that declares tables but is missing here boots with no table applied,
 * and its first `ctx.dexie.table(...)` throws a lookup error at call time
 * instead of anything failing at boot.
 */
it("covers every bundled plugin that declares tables", () => {
  const declared = pluginsDeclaringTables()
  expect(declared.length).toBeGreaterThan(0)

  const expected = declared.filter((id) => !(id in KNOWN_UNREGISTERED))
  expect([...getBuiltinPluginDexieManifests().keys()].sort()).toEqual(expected)

  // A stale exclusion is its own drift: a plugin that stopped declaring tables
  // should leave this list rather than sit here explaining nothing.
  expect(Object.keys(KNOWN_UNREGISTERED).filter((id) => !declared.includes(id))).toEqual([])
})

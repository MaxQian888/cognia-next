import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import type { PluginRuntimeProfile } from "@/types/plugin"

/**
 * Walks every built-in plugin manifest under `plugins/*\/plugin.json` and
 * asserts the manifest shape conforms to the host's canonical contracts.
 *
 * The point of this test is to prevent drift: when contributors copy an old
 * manifest as a template, fields like `runtimeCompatibility` accumulate
 * non-canonical keys (e.g. `desktop` instead of `tauri`) that silently
 * disable the corresponding runtime check at install time.
 */

const PLUGINS_DIR = join(process.cwd(), "plugins")
const CANONICAL_RUNTIME_SURFACES: ReadonlyArray<PluginRuntimeProfile> = [
  "browser",
  "tauri",
  "mobile",
]
const RUNTIME_AVAILABILITIES = ["supported", "degraded", "blocked"] as const

function listManifests(): { plugin: string; path: string; json: Record<string, unknown> }[] {
  const out: { plugin: string; path: string; json: Record<string, unknown> }[] = []
  for (const entry of readdirSync(PLUGINS_DIR)) {
    const pluginRoot = join(PLUGINS_DIR, entry)
    if (!statSync(pluginRoot).isDirectory()) continue
    const manifestPath = join(pluginRoot, "plugin.json")
    let raw: string
    try {
      raw = readFileSync(manifestPath, "utf8")
    } catch {
      continue
    }
    out.push({
      plugin: entry,
      path: manifestPath,
      json: JSON.parse(raw) as Record<string, unknown>,
    })
  }
  return out
}

describe("built-in plugin manifests", () => {
  const manifests = listManifests()

  it("discovers at least one built-in plugin", () => {
    expect(manifests.length).toBeGreaterThan(0)
  })

  it.each(manifests.map((m) => [m.plugin, m] as const))(
    "%s declares only canonical runtimeCompatibility keys",
    (_plugin, manifest) => {
      const compat = manifest.json.runtimeCompatibility as Record<string, unknown> | undefined
      if (!compat) return
      for (const key of Object.keys(compat)) {
        expect(CANONICAL_RUNTIME_SURFACES).toContain(key as PluginRuntimeProfile)
      }
    }
  )

  // Mobile (Capacitor) is a first-class runtime surface: every built-in that
  // declares runtimeCompatibility MUST declare an explicit `mobile` availability
  // so the Capacitor shell loads only the supported subset instead of inheriting
  // browser availability by accident (which re-opens the boot toast flood). See
  // the manager's collectRuntimeProfileDiagnostics + isBlockedByRuntimeProfile.
  it.each(manifests.map((m) => [m.plugin, m] as const))(
    "%s declares an explicit mobile runtime availability",
    (_plugin, manifest) => {
      const compat = manifest.json.runtimeCompatibility as
        Record<string, { availability?: string } | undefined> | undefined
      if (!compat) return
      expect(compat.mobile).toBeDefined()
      expect(RUNTIME_AVAILABILITIES).toContain(compat.mobile?.availability as never)
    }
  )
})

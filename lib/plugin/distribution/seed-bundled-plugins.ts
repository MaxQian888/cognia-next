/**
 * Copy the plugins that ship inside the installer into the host's plugin
 * directory, once per version.
 *
 * Frontend plugins live in the JS bundle and need no disk presence. Python and
 * WASM plugins do: the Tauri host discovers a plugin by finding a
 * `plugin.json` under `<appDataDir>/cognia/plugins`, and nothing ever put one
 * there. `plugins/` was not in `bundle.resources` either, so RepoWiki
 * (ADR-0146, a whole subsystem with its own 213-case gate suite) was present
 * in the repository and absent from every installed build.
 * `scripts/build/stage-bundled-plugins.mjs` stages the shipping files into the
 * resource tree. This is the other half, run once at plugin-runtime boot.
 *
 * It deliberately owns no copying of its own. `plugin_install_from_directory`
 * already does exactly this job for the "Load unpacked" affordance, including
 * the part that is easy to get wrong: `replace_directory_atomically`, so a
 * crash mid-copy cannot leave a half-written plugin that the next scan would
 * try to load.
 *
 * ## Policy, stated rather than implied
 *
 * - **Upgrade.** The marker records the version that was seeded. A newer
 *   bundled version re-seeds, which replaces the directory wholesale. Local
 *   edits to a bundled plugin do not survive that, which is the right trade
 *   for something the installer owns.
 * - **Deletion.** If the user removes the plugin, the marker stays and it is
 *   NOT re-seeded on the next launch. Re-installing what someone deliberately
 *   removed, every launch, is the worse failure.
 * - **Enablement.** Seeding installs, it does not enable. RepoWiki is listed
 *   in `MANUAL_ENABLE_ONLY_BUILTINS`, so it stays dormant until the user turns
 *   it on and startup cost is unchanged.
 */

import { loggers } from "@cognia/logging"

import stagedCatalog from "./bundled-plugins.generated.json"

const log = loggers.manager.child("bundled-plugin-seed")

/** Where the staged plugin directories sit inside the bundle. */
export const STAGED_PLUGIN_ROOT = "resources/plugins"
/** localStorage key holding `{ [directory]: seededVersion }`. */
export const SEED_MARKER_KEY = "cognia.bundledPluginSeed"

export interface StagedPluginFile {
  path: string
  bytes: number
  sha256: string
}

export interface StagedPluginEntry {
  id: string
  version: string
  files: StagedPluginFile[]
}

export interface StagedPluginCatalog {
  entries: Record<string, StagedPluginEntry>
}

export interface SeedBundledPluginsDeps {
  /** Absolute path of a directory inside the bundle's resource directory. */
  resolveResource: (relative: string) => Promise<string>
  /** `plugin_install_from_directory`, an atomic replace plus host registration. */
  installFromDirectory: (sourceDir: string) => Promise<void>
  readMarker: () => Record<string, string>
  writeMarker: (next: Record<string, string>) => void
  /** Defaults to the generated catalog. Overridden only by tests. */
  catalog?: StagedPluginCatalog
}

export interface SeedOutcome {
  /** Directories seeded on this run, in catalog order. */
  seeded: string[]
  /** Directories skipped because the marker already names this version. */
  upToDate: string[]
  /** Directory to failure message. A failure never blocks the others. */
  failed: Record<string, string>
}

/**
 * Read the marker without letting a corrupt or unavailable store throw. A
 * private window and a cleared profile both surface here, and neither is a
 * reason to refuse to boot the plugin runtime.
 */
export function readSeedMarker(
  storage: Storage | undefined = globalThis.localStorage
): Record<string, string> {
  try {
    const raw = storage?.getItem(SEED_MARKER_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

export function writeSeedMarker(
  next: Record<string, string>,
  storage: Storage | undefined = globalThis.localStorage
): void {
  try {
    storage?.setItem(SEED_MARKER_KEY, JSON.stringify(next))
  } catch {
    // A marker we cannot persist means we re-seed next launch. That is a
    // wasted copy of a few hundred kilobytes, not a correctness problem, so
    // it must not take the boot down with it.
  }
}

/** The catalog the staging step produced for this build. */
export function bundledPluginCatalog(): StagedPluginCatalog {
  return stagedCatalog as StagedPluginCatalog
}

/**
 * Seed every staged plugin whose recorded version differs from the bundled
 * one. Never throws: a resource that cannot be resolved, or an install the
 * host refuses, is recorded in `failed` and the runtime still starts. A plugin
 * that will not install must not take the plugin system down with it.
 */
export async function seedBundledPlugins(deps: SeedBundledPluginsDeps): Promise<SeedOutcome> {
  const outcome: SeedOutcome = { seeded: [], upToDate: [], failed: {} }
  const catalog = deps.catalog ?? bundledPluginCatalog()

  const marker = deps.readMarker()
  const next = { ...marker }

  for (const [directory, entry] of Object.entries(catalog.entries)) {
    if (marker[directory] === entry.version) {
      outcome.upToDate.push(directory)
      continue
    }
    try {
      const sourceDir = await deps.resolveResource(`${STAGED_PLUGIN_ROOT}/${directory}`)
      await deps.installFromDirectory(sourceDir)
      // Recorded only after the install returns. A marker written first would
      // turn one failed copy into a plugin that never appears again.
      next[directory] = entry.version
      outcome.seeded.push(directory)
      log.info("seeded bundled plugin", { id: entry.id, version: entry.version })
    } catch (error) {
      outcome.failed[directory] = error instanceof Error ? error.message : String(error)
      log.warn("bundled plugin seed failed", { id: entry.id, error })
    }
  }

  if (outcome.seeded.length > 0) deps.writeMarker(next)
  return outcome
}

/**
 * The production wiring. Split from `seedBundledPlugins` so the policy above
 * is testable without Tauri, and kept thin so there is little here that the
 * tests do not reach.
 */
export async function seedBundledPluginsOnHost(): Promise<SeedOutcome> {
  const [{ resolveResource }, { invoke }] = await Promise.all([
    import("@tauri-apps/api/path"),
    import("@tauri-apps/api/core"),
  ])
  return seedBundledPlugins({
    resolveResource: (relative) => resolveResource(relative),
    installFromDirectory: async (sourceDir) => {
      await invoke("plugin_install_from_directory", { sourceDir })
    },
    readMarker: () => readSeedMarker(),
    writeMarker: (nextMarker) => writeSeedMarker(nextMarker),
  })
}

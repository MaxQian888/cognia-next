// Sequential installer for a marketplace preset — a named bundle of plugins
// declared by a GitHub `marketplace.json` catalog.
//
// Each member still runs the FULL pre-install chain (conflict → permission →
// binaries → config) because the caller's `install` is `usePluginPreInstall`'s
// — this file only decides *which* members run and when to stop. Members are
// processed in the order the preset declares them.
//
// Semantics:
// - a member whose manifest id is already installed is reported `skipped`
//   (installed-state is only knowable after the preview resolves the
//   converted manifest id — the catalog entry id is not the manifest id);
// - a `failed` member is recorded and the bundle continues — one broken
//   plugin should not block the rest;
// - a user `cancelled` result stops the bundle: every member not yet
//   attempted is also reported `cancelled`, so the four buckets always
//   partition the member list exactly.

import type { GithubMarketplaceEntry } from "@/lib/plugin/package/github-marketplace"
import {
  fetchGithubPluginPreview,
  makeGithubMarketplaceClient,
  type GithubMarketplaceClient,
  type GithubPluginPreview,
} from "@/lib/plugin/package/github-source"
import type { RunMarketplaceInstallResult } from "./install-flow"

export interface PresetInstallResult {
  /** Manifest ids that finished installed. */
  installed: string[]
  /** Members whose install returned `failed` — bundle kept going. */
  failed: Array<{ id: string; name: string; message: string }>
  /**
   * The member the user cancelled on plus every member never attempted.
   * Values are manifest ids when a preview resolved them, otherwise the
   * catalog entry id.
   */
  cancelled: string[]
  /** Members skipped because the converted manifest id is already installed. */
  skipped: string[]
}

export interface RunPresetInstallOpts {
  members: GithubMarketplaceEntry[]
  /**
   * Reports whether a converted manifest id is already installed. Called
   * after each member's preview resolves — `GithubMarketplaceEntry.id` is a
   * catalog key, not the manifest id, so there is no earlier point where
   * installed-state is knowable.
   */
  isInstalled: (manifestId: string) => boolean
  /**
   * The pre-install chain — `usePluginPreInstall.install` with the
   * `clientOverride` argument, one GitHub client per member.
   */
  install: (
    pluginId: string,
    version: string | undefined,
    pluginName: string,
    client: GithubMarketplaceClient
  ) => Promise<RunMarketplaceInstallResult>
  /** Injectable for tests — defaults to `fetchGithubPluginPreview`. */
  preview?: (entry: GithubMarketplaceEntry) => Promise<GithubPluginPreview>
  /** Called once per completed member attempt — installed, failed, skipped or cancelled. */
  onProgress?: (completed: number, total: number, entry: GithubMarketplaceEntry) => void
}

export async function runPresetInstall(opts: RunPresetInstallOpts): Promise<PresetInstallResult> {
  const { members, isInstalled, install, onProgress } = opts
  const preview = opts.preview ?? ((entry) => fetchGithubPluginPreview(entry.github))
  const result: PresetInstallResult = { installed: [], failed: [], cancelled: [], skipped: [] }
  let completed = 0

  for (let i = 0; i < members.length; i++) {
    const entry = members[i]

    let memberPreview: GithubPluginPreview
    try {
      memberPreview = await preview(entry)
    } catch (err) {
      result.failed.push({
        id: entry.id,
        name: entry.name,
        message: err instanceof Error ? err.message : String(err),
      })
      completed++
      onProgress?.(completed, members.length, entry)
      continue
    }

    const manifest = memberPreview.manifest
    if (isInstalled(manifest.id)) {
      result.skipped.push(manifest.id)
      completed++
      onProgress?.(completed, members.length, entry)
      continue
    }

    const client = makeGithubMarketplaceClient(memberPreview.ref, memberPreview)
    const outcome = await install(manifest.id, undefined, manifest.name, client)
    completed++
    onProgress?.(completed, members.length, entry)

    if (outcome.status === "installed") {
      result.installed.push(manifest.id)
      continue
    }
    if (outcome.status === "failed") {
      result.failed.push({ id: manifest.id, name: manifest.name, message: outcome.message })
      continue
    }

    // Cancelled: stop the bundle. The cancelled member plus every member
    // never attempted all land in `cancelled` — nothing is left unaccounted.
    result.cancelled.push(manifest.id)
    for (const rest of members.slice(i + 1)) result.cancelled.push(rest.id)
    break
  }

  return result
}

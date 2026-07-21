/**
 * `--into <existing-plugin-dir>`: add one contribution to a plugin that
 * already exists.
 *
 * The merge is deliberately narrow. It does exactly two things — union the
 * capability into `capabilities[]`, and append the contribution to its
 * manifest array — plus the permissions the contribution genuinely needs.
 * It does not bump `version`, does not touch `src/`, does not reorder or
 * reformat beyond what a JSON round-trip implies (key insertion order is
 * preserved; indentation becomes the repo-standard two spaces).
 *
 * An id collision is an error, never a silent overwrite and never an
 * auto-rename: the author asked to add a specific thing, and quietly
 * shadowing or renaming their existing entry would be a worse outcome than
 * stopping.
 *
 * Runtime compatibility is *reported*, not rewritten. Adding a stdio MCP
 * preset to a plugin that advertises browser support makes that claim
 * wrong, but silently narrowing a host plugin's declared reach could
 * disable unrelated contributions it already ships. The author is told
 * precisely what to change.
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import { deriveRuntimeCompatibility, type RuntimeNeed } from "./manifest"

/** One contribution to splice into an existing manifest. */
export interface MergeRequest {
  capability: string
  manifestField: string
  entry: { id: string; [key: string]: unknown }
  permissions?: string[]
  need: RuntimeNeed
}

export interface MergeOutcome {
  manifest: PluginManifest
  warnings: string[]
}

/** Parse an existing `plugin.json`, failing loudly on anything unusable. */
export function parseExistingManifest(text: string, path: string): PluginManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`)
  }
  const manifest = parsed as Partial<PluginManifest>
  if (typeof manifest.id !== "string" || !manifest.id) {
    throw new Error(`${path} is missing a string \`id\``)
  }
  return manifest as PluginManifest
}

/**
 * Splice `request` into `existing`. Returns a new manifest; the input is
 * never mutated.
 */
export function mergeContribution(existing: PluginManifest, request: MergeRequest): MergeOutcome {
  const warnings: string[] = []
  const manifest = JSON.parse(JSON.stringify(existing)) as PluginManifest
  const record = manifest as unknown as Record<string, unknown>

  // --- capabilities ------------------------------------------------------
  const capabilities = Array.isArray(manifest.capabilities) ? [...manifest.capabilities] : []
  if (!capabilities.includes(request.capability as never)) {
    capabilities.push(request.capability as never)
  }
  manifest.capabilities = capabilities as PluginManifest["capabilities"]

  // --- contribution array ------------------------------------------------
  const current = record[request.manifestField]
  if (current !== undefined && !Array.isArray(current)) {
    throw new Error(
      `existing manifest field "${request.manifestField}" is not an array — refusing to overwrite it`
    )
  }
  const entries = Array.isArray(current) ? [...(current as Array<{ id?: unknown }>)] : []
  if (entries.some((e) => e && typeof e === "object" && e.id === request.entry.id)) {
    throw new Error(
      `"${request.manifestField}" already contains an entry with id "${request.entry.id}" — ` +
        "pass --id to give the imported one a different id, or remove the existing entry first"
    )
  }
  entries.push(request.entry)
  record[request.manifestField] = entries

  // --- permissions -------------------------------------------------------
  if (request.permissions?.length) {
    const permissions = Array.isArray(manifest.permissions) ? [...manifest.permissions] : []
    for (const permission of request.permissions) {
      if (!permissions.includes(permission as never)) {
        permissions.push(permission as never)
        warnings.push(`added required permission "${permission}"`)
      }
    }
    manifest.permissions = permissions as PluginManifest["permissions"]
  }

  // --- runtime compatibility (reported, not rewritten) -------------------
  if (request.need !== "portable") {
    const required = deriveRuntimeCompatibility(request.need)
    for (const target of ["browser", "mobile"] as const) {
      const declared = manifest.runtimeCompatibility?.[target]?.availability
      if (declared && declared !== "blocked") {
        warnings.push(
          `runtimeCompatibility.${target} is "${declared}", but the imported contribution cannot run there — ` +
            `set it to "blocked" with reason: ${required[target]?.reason ?? ""}`
        )
      }
    }
  }

  return { manifest, warnings }
}

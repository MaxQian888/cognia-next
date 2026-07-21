/**
 * Rebase a plugin-contributed skill's `source.path` against the plugin's
 * install root.
 *
 * `PluginSkillDef` sources of kind `local-folder` / `local-bundle` /
 * `archive` carry a filesystem path. Downstream, `resolveSkillMarkdown`
 * (`lib/claude/skills-io.ts`) hands that path straight to
 * `@tauri-apps/plugin-fs` — it receives only the def, never the owning
 * plugin, so a *relative* path resolved against the process cwd instead of
 * the plugin directory. That left plugin authors with two bad options:
 * ship an absolute path (works only on the author's machine) or ship a
 * relative path (never resolves). Every other plugin-dir reference in the
 * manifest — `main`, `wasmMain`, `cliTools[].binary.relPath` — is already
 * plugin-dir-relative, so skills were the odd one out.
 *
 * The rebase happens ONCE, at registration time (the overlay dispatch loop
 * in `PluginManager.registerPluginContributions`), so everything
 * downstream keeps seeing a single absolute path and needs no change.
 *
 * Absolute paths pass through untouched: an author who deliberately points
 * at a shared location outside the plugin keeps that behaviour, and
 * built-in plugins (whose `installRoot` is a `builtin://` pseudo-path or
 * empty) are left alone.
 */

import type { PluginSkillDef, PluginSkillSource } from "@/types/plugin/plugin-skill"

/** Source kinds that carry a filesystem path needing a base directory. */
const PATH_BEARING_KINDS = new Set<PluginSkillSource["kind"]>([
  "local-folder",
  "local-bundle",
  "archive",
])

/**
 * True when `path` is already anchored and must not be rebased:
 * POSIX absolute (`/x`), Windows drive-absolute (`C:\x` / `C:/x`), UNC
 * (`\\server\share`), or a URL-ish scheme (`builtin://`, `asset://`).
 */
export function isAnchoredPath(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("\\")) return true
  if (/^[A-Za-z]:[\\/]/.test(path)) return true
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path)) return true
  return false
}

/**
 * True when a *relative* path climbs out of its base directory once
 * normalised (`../x`, `a/../../x`, and their backslash spellings).
 *
 * Hand-rolled rather than `node:path` because this module runs in the
 * renderer (and in the mobile bundle), where `node:path` is stubbed out.
 */
export function escapesBaseDir(path: string): boolean {
  let depth = 0
  for (const segment of path.split(/[\\/]+/)) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      depth -= 1
      if (depth < 0) return true
      continue
    }
    depth += 1
  }
  return false
}

/** Join `base` and `relative` with a single forward slash. */
function joinPath(base: string, relative: string): string {
  const root = base.replace(/[\\/]+$/, "")
  const tail = relative.replace(/^[\\/]+/, "")
  return `${root}/${tail}`
}

/**
 * Return `def` with any plugin-dir-relative `source.path` resolved against
 * `installRoot`.
 *
 * - Non-path sources (`inline`, `anthropic-managed`) are returned as-is.
 * - Anchored paths (absolute / UNC / scheme-prefixed) are returned as-is.
 * - An empty `installRoot` (built-ins, or a plugin whose path is unknown)
 *   leaves the def untouched — there is nothing to rebase against.
 *
 * @throws when a relative path escapes the plugin directory. The overlay
 * dispatch loop isolates per-entry failures, so this drops exactly the
 * offending skill and logs why, rather than registering a def that reaches
 * outside the plugin's own directory.
 */
export function rebaseSkillSource(def: PluginSkillDef, installRoot: string): PluginSkillDef {
  // The dispatch loop reads the manifest field generically and can only
  // prove `id` is present, so a malformed def reaches here intact. Leave
  // it alone and let the registry / consumers report the real problem.
  const source = def.source as PluginSkillSource | undefined
  if (!source || !PATH_BEARING_KINDS.has(source.kind)) return def

  // Narrowed by the set membership above; every path-bearing variant has
  // a `path` field.
  const pathed = source as Extract<PluginSkillSource, { path: string }>
  if (!installRoot || isAnchoredPath(pathed.path)) return def

  if (escapesBaseDir(pathed.path)) {
    throw new Error(`skill "${def.id}" source path "${pathed.path}" escapes the plugin directory`)
  }

  return { ...def, source: { ...pathed, path: joinPath(installRoot, pathed.path) } }
}

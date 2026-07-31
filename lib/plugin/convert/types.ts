/**
 * Shared types for `cognia plugin import` — the source-to-plugin converter.
 *
 * The converter turns an artifact the user already has (an MCP server entry
 * in some agent's config, a SKILL.md folder, an external CLI binary) into a
 * cognia plugin *project*: a directory the author can edit, build, install,
 * and push to a git remote for the in-app GitHub installer to consume.
 *
 * Design constraints that shape everything here:
 *
 * - **Nothing is executed.** No MCP server is spawned, no `--help` is run,
 *   nothing is fetched. Conversion reads text and writes text, so it is
 *   deterministic and testable with no process or network sandboxing.
 * - **The core is pure.** Filesystem IO lives in `cli.ts` (the node entry
 *   the Rust CLI shells out to); everything in this directory operates on
 *   strings and plain objects, mirroring how `lib/skills/bundle/loader.ts`
 *   keeps file walking out of its parsers.
 * - **No values are copied.** Credentials in the source config never reach
 *   the generated `plugin.json`; they become user-filled preset fields.
 */

import type { PluginManifest } from "@/types/plugin/plugin"

/** Which kind of artifact is being converted. */
export type ConvertSourceKind = "mcp" | "skill" | "cli"

/** One thing the user could `--pick` out of the supplied input. */
export interface ConvertCandidate {
  /** The exact value to pass as `--pick`. */
  id: string
  /** Human-readable label for the chooser listing. */
  label: string
  /** One-line detail (transport + command, skill description, …). */
  detail?: string
}

/** Author-supplied overrides for the generated plugin's identity. */
export interface ConvertIdentityOverrides {
  id?: string
  name?: string
  description?: string
  version?: string
  author?: string
  authorEmail?: string
  license?: string
  minAppVersion?: string
}

/** Everything the pure core needs to produce a plugin, already read as text. */
export interface ConvertInput {
  kind: ConvertSourceKind
  /**
   * Raw text of the source artifact:
   * - `mcp`   — the agent config file's contents.
   * - `skill` — the SKILL.md body.
   * - `cli`   — unused (the binary is referenced by name, never read).
   */
  text?: string
  /**
   * Basename of the source path. Used to pick an MCP agent adapter and to
   * fall back for a skill's name when its frontmatter omits one.
   */
  sourceName?: string
  /** For `cli`: the binary name to wrap (e.g. `rg`). */
  binary?: string
  /**
   * For `skill`: sibling resource files discovered next to SKILL.md,
   * relative to the skill folder (e.g. `references/api.md`). Presence
   * flips the generated source from `inline` to `local-bundle`.
   */
  resources?: string[]
  /** Which candidate to convert. Required when the input holds several. */
  pick?: string
  identity?: ConvertIdentityOverrides
}

/**
 * A generated plugin project as a path → contents map, relative to the
 * output directory. Binary resources are copied by `cli.ts` and never
 * appear here.
 */
export type ConvertFileMap = Map<string, string>

/** Result of a greenfield conversion. */
export interface ConvertCreateResult {
  mode: "create"
  pluginId: string
  manifest: PluginManifest
  files: ConvertFileMap
  /** Files to copy verbatim from the source, as `from` → `to` (relative). */
  copies: Array<{ from: string; to: string }>
  /** Things the author must act on (unfilled credentials, empty tool table). */
  todos: string[]
  /** Non-blocking observations (dropped entries, inferred compatibility). */
  warnings: string[]
}

/** Result of merging one contribution into an existing plugin. */
export interface ConvertMergeResult {
  mode: "merge"
  pluginId: string
  /** The rewritten `plugin.json` contents. */
  manifest: PluginManifest
  files: ConvertFileMap
  copies: Array<{ from: string; to: string }>
  todos: string[]
  warnings: string[]
}

export type ConvertResult = ConvertCreateResult | ConvertMergeResult

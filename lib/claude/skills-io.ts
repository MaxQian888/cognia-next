// Serialize / parse skills as Markdown files with YAML frontmatter, matching
// the Claude Code SKILL.md convention so skills roundtrip cleanly between
// cognia-next, Cognia, and `~/.claude/skills/<name>/SKILL.md`.
//
// Frontmatter shape:
//   ---
//   name: My Skill
//   description: One-line summary (optional)
//   allowed-tools: [Read, WebSearch]   # array OR comma-list string
//   tags: [style, accuracy]            # our extension; ignored by Claude Code
//   category: development              # our extension (8 values)
//   version: 1.0.0                     # our extension
//   author: Jane Doe                   # our extension
//   license: MIT                       # our extension
//   ---
//   <markdown body>

import matter from "gray-matter"
import type { Skill, SkillCategory } from "./types"
import type { SkillDraft } from "@/lib/db/skills"
import type { PluginSkillDef } from "@/types/plugin/plugin-skill"
import { isTauri } from "@/lib/tauri"

const VALID_CATEGORIES: SkillCategory[] = [
  "creative-design",
  "development",
  "enterprise",
  "productivity",
  "data-analysis",
  "communication",
  "meta",
  "custom",
]

export interface ParseResult {
  draft: SkillDraft
  /** Issues encountered during parsing (e.g., name fallback). Non-fatal. */
  warnings: string[]
}

export interface ParseError {
  filename?: string
  error: string
}

/** A subset of `Skill` that's safe / meaningful to export. */
export type ExportableSkill = Pick<
  Skill,
  | "name"
  | "description"
  | "content"
  | "allowedTools"
  | "tags"
  | "category"
  | "version"
  | "author"
  | "license"
>

/**
 * Render a skill as a SKILL.md string with YAML frontmatter. The output
 * matches Claude Code's expected format and is readable by both systems.
 */
export function serializeSkill(skill: ExportableSkill): string {
  const data: Record<string, unknown> = {
    name: skill.name,
  }
  if (skill.description?.trim()) data.description = skill.description.trim()
  if (skill.allowedTools && skill.allowedTools.length > 0) {
    data["allowed-tools"] = [...skill.allowedTools]
  }
  if (skill.tags && skill.tags.length > 0) {
    data.tags = [...skill.tags]
  }
  // Extra cognia-next / Cognia metadata. Claude Code ignores unknown keys.
  if (skill.category && skill.category !== "custom") {
    data.category = skill.category
  }
  if (skill.version?.trim()) data.version = skill.version.trim()
  if (skill.author?.trim()) data.author = skill.author.trim()
  if (skill.license?.trim()) data.license = skill.license.trim()

  const body = skill.content.endsWith("\n") ? skill.content : `${skill.content}\n`
  return matter.stringify(body, data)
}

/**
 * Parse a SKILL.md string into a `SkillDraft`. Tolerant of missing
 * frontmatter, missing name (falls back to `opts.fallbackName`), and
 * either YAML-array or comma-separated list values for tools/tags.
 */
export function parseSkillMarkdown(
  text: string,
  opts: { fallbackName?: string } = {}
): ParseResult {
  const warnings: string[] = []

  let parsed: matter.GrayMatterFile<string>
  try {
    parsed = matter(text)
  } catch (err) {
    throw new Error(
      `Failed to parse frontmatter: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  const fm = (parsed.data ?? {}) as Record<string, unknown>
  const body = parsed.content.trim()

  let name = stringOrUndef(fm.name)
  if (!name) {
    name = opts.fallbackName?.trim() || ""
    if (name) warnings.push(`No 'name' in frontmatter — using "${name}".`)
  }
  if (!name) {
    throw new Error("Skill is missing a name (no frontmatter and no fallback).")
  }

  if (!body) {
    throw new Error(`Skill "${name}" has no content body.`)
  }

  const description = stringOrUndef(fm.description)
  const allowedTools = parseList(fm["allowed-tools"]) ?? parseList(fm.allowedTools)
  const tags = parseList(fm.tags)
  const categoryRaw = stringOrUndef(fm.category)?.toLowerCase()
  const category = (VALID_CATEGORIES as string[]).includes(categoryRaw ?? "")
    ? (categoryRaw as SkillCategory)
    : undefined
  if (categoryRaw && !category) {
    warnings.push(`Unknown category "${categoryRaw}" — falling back to "custom".`)
  }
  const version = stringOrUndef(fm.version)
  const author = stringOrUndef(fm.author)
  const license = stringOrUndef(fm.license)

  return {
    draft: {
      name,
      description,
      content: body,
      allowedTools,
      tags,
      category,
      version,
      author,
      license,
    },
    warnings,
  }
}

/** Derive a sensible filename ("kebab-case.md") from a skill name. */
export function skillFilename(name: string): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "skill"
  return `${slug}.md`
}

/** Strip the `.md` / `.markdown` extension from a filename for fallback names. */
export function nameFromFilename(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim()
}

// ---- helpers --------------------------------------------------------------

function stringOrUndef(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined
  const trimmed = v.trim()
  return trimmed ? trimmed : undefined
}

function parseList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const arr = v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean)
    return arr.length > 0 ? arr : undefined
  }
  if (typeof v === "string") {
    const arr = v
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
    return arr.length > 0 ? arr : undefined
  }
  return undefined
}

// ---- Plugin skill IO (M4) -----------------------------------------------
//
// Plugins shipping the `skills` capability (`PluginSkillDef`) supply skill
// content through one of three sources: `inline` markdown, an Anthropic
// managed container skill (referenced by id, no body to read), or a
// `local-folder` path containing a `SKILL.md`. `resolveSkillMarkdown` is
// the single entry point the runtime uses to fetch the body — it returns
// `undefined` for the managed flavour so the caller routes it via the
// sidecar's `containerSkillIds` channel instead.

/**
 * Read the SKILL.md body for a plugin-contributed skill.
 *
 * - `inline`: return the markdown verbatim.
 * - `anthropic-managed`: returns `undefined` (the skill content lives in
 *   Anthropic's container and is referenced by `containerSkillId` instead).
 * - `local-folder`: read `<path>/SKILL.md` off disk. Tauri only. In browser
 *   mode this returns a placeholder string explaining the limitation —
 *   the same defensive shape it uses when fs read fails so resolver
 *   callers never see a thrown error.
 */
export async function resolveSkillMarkdown(def: PluginSkillDef): Promise<string | undefined> {
  if (def.source.kind === "inline") return def.source.markdown
  if (def.source.kind === "anthropic-managed") return undefined
  if (def.source.kind === "local-folder") {
    if (!isTauri()) {
      return `[skill "${def.id}": local-folder source not available in browser mode]`
    }
    try {
      const { readTextFile } = await import("@tauri-apps/plugin-fs")
      const root = def.source.path.replace(/[/\\]+$/, "")
      const fullPath = `${root}/SKILL.md`
      return await readTextFile(fullPath)
    } catch (err) {
      return `[skill "${def.id}": failed to read SKILL.md: ${err instanceof Error ? err.message : String(err)}]`
    }
  }
  return undefined
}

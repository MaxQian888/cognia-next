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

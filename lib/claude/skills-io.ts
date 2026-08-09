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
import type { Skill, SkillCategory, SkillValidationError } from "@cognia/agent-config-types"
import type { SkillDraft } from "@/lib/db/skills"
import type { PluginSkillDef } from "@/types/plugin/plugin-skill"
import { isTauri } from "@/lib/tauri"
import { replacePluginRootTokens } from "@/lib/plugin/utils/plugin-root-tokens"
import { deriveSkillSlug, isValidSkillSlug } from "@/lib/skills/slug"

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

/**
 * The full set of frontmatter keys this parser recognises. Anything else
 * surfaces as a warning so users notice typos (e.g. `tag` vs `tags`) and
 * Claude Code-only dynamic-trigger keys (`priority`, `sessionStart`,
 * `pathPatterns`, `bashPatterns`, `importPatterns`, `promptSignals`) don't
 * get silently dropped — they're listed here as "known but not modelled"
 * so the warning is honest.
 */
const KNOWN_FRONTMATTER_KEYS = new Set<string>([
  "name",
  "description",
  "compatibility",
  "metadata",
  "allowed-tools",
  "allowedTools",
  "tags",
  "category",
  "version",
  "author",
  "license",
  "disable-model-invocation",
  "allow_implicit_invocation",
])

const KNOWN_BUT_UNMODELLED_KEYS = new Set<string>([
  "priority",
  "sessionStart",
  "pathPatterns",
  "bashPatterns",
  "importPatterns",
  "promptSignals",
])

export interface ParseResult {
  draft: SkillDraft
  /** Issues encountered during parsing (e.g., name fallback). Non-fatal. */
  warnings: string[]
  /** Portability findings caused by tolerant legacy normalization. */
  portabilityIssues: SkillValidationError[]
}

export interface ParseError {
  filename?: string
  error: string
}

/** A subset of `Skill` that's safe / meaningful to export. */
export type ExportableSkill = Pick<
  Skill,
  | "name"
  | "slug"
  | "description"
  | "compatibility"
  | "metadata"
  | "invocationPolicy"
  | "frontmatterExtensions"
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
  const slug = deriveSkillSlug({ id: "skill-export", name: skill.name, slug: skill.slug })
  const data: Record<string, unknown> = { ...(skill.frontmatterExtensions ?? {}), name: slug }
  if (skill.description?.trim()) data.description = skill.description.trim()
  if (skill.compatibility?.trim()) data.compatibility = skill.compatibility.trim()
  if (skill.allowedTools && skill.allowedTools.length > 0) {
    data["allowed-tools"] = skill.allowedTools.join(" ")
  }
  const extensionMetadata = skill.frontmatterExtensions?.metadata
  const metadata: Record<string, unknown> = {
    ...(extensionMetadata &&
    typeof extensionMetadata === "object" &&
    !Array.isArray(extensionMetadata)
      ? (extensionMetadata as Record<string, unknown>)
      : {}),
    ...(skill.metadata ?? {}),
  }
  metadata["cognia.display-name"] = skill.name
  if (skill.author?.trim()) metadata.author = skill.author.trim()
  if (skill.version?.trim()) metadata.version = skill.version.trim()
  if (skill.category && skill.category !== "custom") metadata["cognia.category"] = skill.category
  if (skill.tags && skill.tags.length > 0) metadata["cognia.tags"] = JSON.stringify(skill.tags)
  if (skill.invocationPolicy) metadata["cognia.invocation-policy"] = skill.invocationPolicy
  if (Object.keys(metadata).length > 0) data.metadata = metadata
  if (skill.invocationPolicy === "explicit") data["disable-model-invocation"] = true
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
  const portabilityIssues: SkillValidationError[] = []

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

  let portableName = stringOrUndef(fm.name)
  if (!portableName) {
    portableName = opts.fallbackName?.trim() || ""
    if (portableName) warnings.push(`No 'name' in frontmatter — using "${portableName}".`)
  }
  if (!portableName) {
    throw new Error("Skill is missing a name (no frontmatter and no fallback).")
  }

  if (!body) {
    throw new Error(`Skill "${portableName}" has no content body.`)
  }

  const description = stringOrUndef(fm.description)
  const compatibility = stringOrUndef(fm.compatibility)
  const allowedTools = parseToolList(fm["allowed-tools"]) ?? parseToolList(fm.allowedTools)
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
  const metadata = parseStringMetadata(fm.metadata, warnings)
  const metadataTags = parseJsonStringArray(metadata?.["cognia.tags"])
  const metadataCategory = metadata?.["cognia.category"]
  const resolvedCategory = (VALID_CATEGORIES as string[]).includes(metadataCategory ?? "")
    ? (metadataCategory as SkillCategory)
    : category
  const invocationMetadata = metadata?.["cognia.invocation-policy"]
  const explicitByVendor =
    fm["disable-model-invocation"] === true || fm.allow_implicit_invocation === false
  const invocationPolicy =
    explicitByVendor || invocationMetadata === "explicit"
      ? ("explicit" as const)
      : invocationMetadata === "implicit"
        ? ("implicit" as const)
        : undefined
  const displayName = metadata?.["cognia.display-name"]?.trim() || portableName
  const slug = deriveSkillSlug({ id: `skill-${portableName}`, name: portableName })

  if (!isValidSkillSlug(portableName)) {
    portabilityIssues.push({
      code: "slug-format",
      field: "slug",
      severity: "portability",
      message: `Imported frontmatter name "${portableName}" was normalized to slug "${slug}".`,
    })
  }

  const frontmatterExtensions = Object.fromEntries(
    Object.entries(fm).filter(
      ([key, value]) =>
        !KNOWN_FRONTMATTER_KEYS.has(key) ||
        (key === "metadata" &&
          (!value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            Object.values(value as Record<string, unknown>).some(
              (entry) => typeof entry !== "string"
            )))
    )
  )

  for (const key of Object.keys(fm)) {
    if (KNOWN_FRONTMATTER_KEYS.has(key)) continue
    if (KNOWN_BUT_UNMODELLED_KEYS.has(key)) {
      warnings.push(
        `Frontmatter key "${key}" is recognised by Claude Code's dynamic-activation model and is preserved without Cognia runtime behavior.`
      )
      continue
    }
    warnings.push(`Unknown frontmatter key "${key}" — preserved.`)
  }

  return {
    draft: {
      name: displayName,
      slug,
      description,
      compatibility,
      metadata,
      content: body,
      allowedTools,
      tags: tags ?? metadataTags,
      category: resolvedCategory,
      version: version ?? metadata?.version,
      author: author ?? metadata?.author,
      license,
      invocationPolicy,
      frontmatterExtensions:
        Object.keys(frontmatterExtensions).length > 0 ? frontmatterExtensions : undefined,
    },
    warnings,
    portabilityIssues,
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

function parseToolList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return parseList(v)
  if (typeof v !== "string") return undefined
  const values = v
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  return values.length > 0 ? values : undefined
}

function parseStringMetadata(
  value: unknown,
  warnings: string[]
): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Frontmatter metadata must be a string-to-string mapping.")
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") out[key] = item
    else warnings.push(`Frontmatter metadata key "${key}" was not a string and was ignored.`)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function parseJsonStringArray(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

// ---- Plugin skill IO (M4) -----------------------------------------------
//
// Plugins shipping the `skills` capability (`PluginSkillDef`) supply skill
// content through one of five sources today: `inline` markdown, an
// Anthropic-managed container skill (referenced by id, no body to read),
// a `local-folder` path containing a `SKILL.md`, a `local-bundle` path
// expected to carry sibling `scripts/`/`references/`/`assets/` directories,
// or an `archive` (`.zip`) of that same bundle layout.
// `resolveSkillMarkdown` is the single entry point the runtime uses to
// fetch the body for the system prompt — it returns `undefined` for the
// managed flavour so the caller routes it via the sidecar's
// `containerSkillIds` channel instead. Resource materialisation for
// `local-bundle` / `archive` flows happens on disk via the disk-mirror
// pipeline (`lib/skills/sync.ts` → `src-tauri/src/skills/install.rs`); the
// system-prompt body is intentionally narrow because Claude's context is
// the SKILL.md body alone.

/**
 * Read the SKILL.md body for a plugin-contributed skill.
 *
 * - `inline`: return the markdown verbatim.
 * - `anthropic-managed`: returns `undefined` (the skill content lives in
 *   Anthropic's container and is referenced by `containerSkillId` instead).
 * - `local-folder` / `local-bundle`: read `<path>/SKILL.md` off disk.
 *   Tauri only. In browser mode this returns `undefined` (the resolver
 *   caller filters undefined bodies out of the rendered system prompt, so
 *   the user gets nothing appended rather than an inline `[skill … not
 *   available]` placeholder leaking into Claude's context). A
 *   `console.warn` is emitted so the developer console surfaces the
 *   dropped skill. The same `undefined` path is used when fs read fails
 *   so resolver callers never see a thrown error.
 * - `archive`: read the `.zip` from disk and parse just the SKILL.md
 *   body via the bundle loader. Resources inside the archive are NOT
 *   pulled into the system prompt — that would defeat the point of the
 *   on-disk extraction step. They land in Dexie / `<appData>/cognia/
 *   skills/<id>/` via the disk-mirror pipeline once the plugin is enabled.
 */
export async function resolveSkillMarkdown(def: PluginSkillDef): Promise<string | undefined> {
  const source = def.source
  const bindRoot = (markdown: string): string =>
    replacePluginRootTokens(markdown, def.runtimePluginRoot ?? "")
  switch (source.kind) {
    case "inline":
      return bindRoot(source.markdown)
    case "anthropic-managed":
      return undefined
    case "local-folder":
    case "local-bundle": {
      if (!isTauri()) {
        console.warn(
          `[skills-io] skill "${def.id}" has a ${source.kind} source; dropped in browser mode`
        )
        return undefined
      }
      try {
        const { readTextFile } = await import("@tauri-apps/plugin-fs")
        const root = source.path.replace(/[/\\]+$/, "")
        const fullPath = `${root}/SKILL.md`
        return bindRoot(await readTextFile(fullPath))
      } catch (err) {
        console.warn(
          `[skills-io] skill "${def.id}" SKILL.md read failed; dropped from prompt: ${err instanceof Error ? err.message : String(err)}`
        )
        return undefined
      }
    }
    case "archive": {
      if (!isTauri()) {
        console.warn(`[skills-io] skill "${def.id}" has an archive source; dropped in browser mode`)
        return undefined
      }
      try {
        // Lazy-import to keep the bundle loader out of the chat-send hot
        // path when no plugin ships an archive skill.
        const { loadBundle } = await import("@/lib/skills/bundle/loader")
        const result = await loadBundle({ kind: "zip-path", path: source.path })
        return bindRoot(result.draft.content)
      } catch (err) {
        console.warn(
          `[skills-io] skill "${def.id}" archive read failed; dropped from prompt: ${err instanceof Error ? err.message : String(err)}`
        )
        return undefined
      }
    }
    default: {
      // Exhaustive narrowing. New PluginSkillSource variants must be
      // handled here; the compiler flags missing arms.
      const exhaustive: never = source
      console.warn(`[skills-io] skill "${def.id}" has an unknown source kind`, exhaustive)
      return undefined
    }
  }
}

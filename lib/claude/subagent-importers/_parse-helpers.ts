// Shared frontmatter helpers for the source adapters in this folder.
// Mirrors the same shape used in `lib/claude/skills-io.ts` so authors who
// know one parser can read the other.
//
// Internal-only — do not export from `index.ts`.

import matter from "gray-matter"
import type { ImportFile, ParseFailure, SubagentImportDraft, SubagentSourceId } from "./types"

export interface ParsedFrontmatter {
  data: Record<string, unknown>
  body: string
}

/** Parse a markdown string into `{ data, body }`. Throws on malformed YAML. */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const parsed = matter(text)
  return {
    data: (parsed.data ?? {}) as Record<string, unknown>,
    body: parsed.content.trim(),
  }
}

export function stringOrUndef(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined
  const trimmed = v.trim()
  return trimmed ? trimmed : undefined
}

/** Accept either an array of strings or a comma/newline-separated string. */
export function parseList(v: unknown): string[] | undefined {
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

/** "Code Reviewer" → "code-reviewer". Used for sourceKey generation. */
export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "subagent"
  )
}

/** Strip `.md` / `.markdown` / `.mdc` and normalize separators to spaces. */
export function nameFromFilename(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim()
}

export function fileMatchesAnyExt(filename: string, exts: string[]): boolean {
  const lower = filename.toLowerCase()
  return exts.some((ext) => lower.endsWith(ext.toLowerCase()))
}

/** Common pre-flight: validate name + body are present, return failure record otherwise. */
export function ensureMinimum(
  file: ImportFile,
  name: string | undefined,
  body: string
): ParseFailure | null {
  if (!name) {
    return { filename: file.filename, error: `Missing name in ${file.filename}` }
  }
  if (!body) {
    return { filename: file.filename, error: `Empty body in ${file.filename}` }
  }
  return null
}

/** Build a SubagentImportDraft, threading sourceKey + sourceFile from the input. */
export interface DraftBuilder {
  source: SubagentSourceId
  file: ImportFile
  name: string
  description?: string
  systemPrompt: string
  tools?: string[]
  model?: string
  providerHint?: SubagentImportDraft["providerHint"]
  rawFrontmatter?: Record<string, unknown>
  warnings?: string[]
}

export function buildDraft(b: DraftBuilder): SubagentImportDraft {
  return {
    source: b.source,
    sourceKey: `${b.source}:${slugify(b.name)}`,
    name: b.name,
    description: b.description,
    systemPrompt: b.systemPrompt,
    tools: b.tools,
    model: b.model,
    providerHint: b.providerHint,
    rawFrontmatter: b.rawFrontmatter,
    sourceFile: b.file.sourcePath,
    warnings: b.warnings ?? [],
  }
}

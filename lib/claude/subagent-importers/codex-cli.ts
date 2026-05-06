// Codex CLI subagent adapter.
//
// Source files: `~/.codex/agents/<name>.md` (per-agent) or `~/.codex/agents.md`
// (single-file YAML array form). Format mirrors Claude Code with extras:
//   - `provider:` field can override the default "openai" provider hint
//   - The single-file form is a top-level YAML array of agents
//
// Frontmatter shape (per-file form):
//   ---
//   name: refactor-bot
//   description: Refactors code for clarity.
//   tools: Read, Edit
//   model: gpt-4o-mini
//   provider: openai
//   ---
//   System prompt body...

import { parse as parseYaml } from "yaml"

import type {
  ImportFile,
  ImportInput,
  ParseResult,
  SubagentImportDraft,
  SubagentSourceAdapter,
} from "./types"
import {
  buildDraft,
  ensureMinimum,
  fileMatchesAnyExt,
  nameFromFilename,
  parseFrontmatter,
  parseList,
  stringOrUndef,
} from "./_parse-helpers"

const ACCEPTED = [".md", ".markdown", ".yaml", ".yml"]
const PATH_HINTS = [".codex/agents", "agents.md"]

const PROVIDER_VALUES = new Set<SubagentImportDraft["providerHint"]>([
  "anthropic",
  "openai",
  "gemini",
])

function normalizeProvider(v: unknown): SubagentImportDraft["providerHint"] {
  const s = stringOrUndef(v)?.toLowerCase()
  if (s && (PROVIDER_VALUES as Set<string>).has(s)) {
    return s as SubagentImportDraft["providerHint"]
  }
  return "openai"
}

function normalizedSourcePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase()
}

function pathMatches(path: string): boolean {
  const lower = normalizedSourcePath(path)
  return PATH_HINTS.some((hint) => lower.includes(hint))
}

/** Parse one entry of the multi-agent YAML array. */
function parseYamlEntry(
  file: ImportFile,
  raw: unknown,
  index: number
): { draft: SubagentImportDraft | null; error: string | null } {
  if (!raw || typeof raw !== "object") {
    return {
      draft: null,
      error: `Entry ${index} in ${file.filename} is not an object`,
    }
  }
  const fm = raw as Record<string, unknown>

  const name = stringOrUndef(fm.name)
  const body =
    stringOrUndef(fm.system_prompt) ??
    stringOrUndef(fm.systemPrompt) ??
    stringOrUndef(fm.prompt) ??
    ""

  if (!name) {
    return { draft: null, error: `Missing name in ${file.filename}[${index}]` }
  }
  if (!body) {
    return { draft: null, error: `Empty body in ${file.filename}[${index}]` }
  }

  return {
    draft: buildDraft({
      source: "codex-cli",
      file,
      name,
      description: stringOrUndef(fm.description),
      systemPrompt: body,
      tools: parseList(fm.tools),
      model: stringOrUndef(fm.model),
      providerHint: normalizeProvider(fm.provider),
      rawFrontmatter: fm,
    }),
    error: null,
  }
}

function parseSingleFile(file: ImportFile): {
  drafts: SubagentImportDraft[]
  errors: ParseResult["errors"]
} {
  // Try YAML-array form first (top-level array of agents).
  const trimmed = file.content.trimStart()
  if (trimmed.startsWith("- ") || trimmed.startsWith("[")) {
    try {
      const parsed = parseYaml(file.content)
      if (Array.isArray(parsed)) {
        const drafts: SubagentImportDraft[] = []
        const errors: ParseResult["errors"] = []
        parsed.forEach((entry, idx) => {
          const r = parseYamlEntry(file, entry, idx)
          if (r.draft) drafts.push(r.draft)
          if (r.error) errors.push({ filename: file.filename, error: r.error })
        })
        return { drafts, errors }
      }
    } catch {
      // Fall through to frontmatter form.
    }
  }

  // Standard frontmatter form.
  let parsed
  try {
    parsed = parseFrontmatter(file.content)
  } catch (err) {
    return {
      drafts: [],
      errors: [
        {
          filename: file.filename,
          error: `Failed to parse ${file.filename}: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    }
  }

  const fm = parsed.data
  const warnings: string[] = []
  let name = stringOrUndef(fm.name)
  if (!name) {
    const fallback = nameFromFilename(file.filename)
    if (fallback) {
      name = fallback
      warnings.push(`No 'name' in frontmatter — using "${name}".`)
    }
  }

  const minErr = ensureMinimum(file, name, parsed.body)
  if (minErr) return { drafts: [], errors: [minErr] }

  return {
    drafts: [
      buildDraft({
        source: "codex-cli",
        file,
        name: name as string,
        description: stringOrUndef(fm.description),
        systemPrompt: parsed.body,
        tools: parseList(fm.tools),
        model: stringOrUndef(fm.model),
        providerHint: normalizeProvider(fm.provider),
        rawFrontmatter: fm,
        warnings,
      }),
    ],
    errors: [],
  }
}

export const codexCliAdapter: SubagentSourceAdapter = {
  id: "codex-cli",
  displayName: "Codex CLI",
  labelKey: "codex-cli",
  acceptedExtensions: ACCEPTED,

  detect(input) {
    const matchingFiles = input.files.filter((f) => pathMatches(f.sourcePath))
    if (matchingFiles.length === 0) return "no"
    if (matchingFiles.length === input.files.length) return "match"
    return "maybe"
  },

  parse(input: ImportInput): ParseResult {
    const drafts: SubagentImportDraft[] = []
    const errors: ParseResult["errors"] = []
    for (const file of input.files) {
      if (!fileMatchesAnyExt(file.filename, ACCEPTED)) continue
      const r = parseSingleFile(file)
      drafts.push(...r.drafts)
      errors.push(...r.errors)
    }
    return { drafts, errors }
  },
}

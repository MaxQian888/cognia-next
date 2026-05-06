// Generic markdown + frontmatter fallback.
//
// Accepts any `.md` / `.markdown` / `.mdc` file with YAML frontmatter and at
// least a discoverable name. Used when no specialized adapter wants the input.
//
// Looked-up frontmatter keys (in order):
//   - name | title
//   - description | summary
//   - tools (array or comma-list) | allowed-tools | allowedTools
//   - model
//   - provider
//   - system_prompt | systemPrompt | prompt   # if present, overrides body

import type { ImportInput, ParseResult, SubagentImportDraft, SubagentSourceAdapter } from "./types"
import {
  buildDraft,
  ensureMinimum,
  fileMatchesAnyExt,
  nameFromFilename,
  parseFrontmatter,
  parseList,
  stringOrUndef,
} from "./_parse-helpers"

const ACCEPTED = [".md", ".markdown", ".mdc"]

const PROVIDER_VALUES = new Set(["anthropic", "openai", "gemini"])

function normalizeProvider(v: unknown): SubagentImportDraft["providerHint"] {
  const s = stringOrUndef(v)?.toLowerCase()
  if (s && PROVIDER_VALUES.has(s)) return s as SubagentImportDraft["providerHint"]
  return undefined
}

export const genericMdAdapter: SubagentSourceAdapter = {
  id: "generic-md",
  displayName: "Generic markdown",
  labelKey: "generic-md",
  acceptedExtensions: ACCEPTED,

  detect(input) {
    const hits = input.files.filter((f) => fileMatchesAnyExt(f.filename, ACCEPTED))
    if (hits.length === 0) return "no"
    // Generic adapter is the lowest-priority fallback; we never return "match"
    // even if every file is .md, so other adapters get first dibs.
    return "maybe"
  },

  parse(input: ImportInput): ParseResult {
    const drafts: SubagentImportDraft[] = []
    const errors: ParseResult["errors"] = []

    for (const file of input.files) {
      if (!fileMatchesAnyExt(file.filename, ACCEPTED)) continue

      let parsed
      try {
        parsed = parseFrontmatter(file.content)
      } catch (err) {
        errors.push({
          filename: file.filename,
          error: `Failed to parse ${file.filename}: ${err instanceof Error ? err.message : String(err)}`,
        })
        continue
      }

      const fm = parsed.data
      const warnings: string[] = []
      let name = stringOrUndef(fm.name) ?? stringOrUndef(fm.title)
      if (!name) {
        const fallback = nameFromFilename(file.filename)
        if (fallback) {
          name = fallback
          warnings.push(`No 'name' or 'title' in frontmatter — using "${name}".`)
        }
      }

      const explicitPrompt =
        stringOrUndef(fm.system_prompt) ??
        stringOrUndef(fm.systemPrompt) ??
        stringOrUndef(fm.prompt)
      const body = explicitPrompt ?? parsed.body

      const minErr = ensureMinimum(file, name, body)
      if (minErr) {
        errors.push(minErr)
        continue
      }

      const tools =
        parseList(fm.tools) ?? parseList(fm["allowed-tools"]) ?? parseList(fm.allowedTools)

      drafts.push(
        buildDraft({
          source: "generic-md",
          file,
          name: name as string,
          description: stringOrUndef(fm.description) ?? stringOrUndef(fm.summary),
          systemPrompt: body,
          tools,
          model: stringOrUndef(fm.model),
          providerHint: normalizeProvider(fm.provider),
          rawFrontmatter: Object.keys(fm).length > 0 ? fm : undefined,
          warnings,
        })
      )
    }

    return { drafts, errors }
  },
}

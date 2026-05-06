// Cline rules adapter.
//
// Source files: `.clinerules/<name>.md`. Cline rules are plain markdown and
// usually have no frontmatter — we still accept frontmatter for forward
// compatibility, but the body alone is sufficient.

import type { ImportInput, ParseResult, SubagentImportDraft, SubagentSourceAdapter } from "./types"
import {
  buildDraft,
  ensureMinimum,
  fileMatchesAnyExt,
  nameFromFilename,
  parseFrontmatter,
  stringOrUndef,
} from "./_parse-helpers"

const ACCEPTED = [".md", ".markdown"]
const PATH_HINT = ".clinerules"

export const clineAdapter: SubagentSourceAdapter = {
  id: "cline",
  displayName: "Cline",
  labelKey: "cline",
  acceptedExtensions: ACCEPTED,

  detect(input) {
    const hits = input.files.filter((f) => f.sourcePath.replace(/\\/g, "/").includes(PATH_HINT))
    if (hits.length === 0) return "no"
    if (hits.length === input.files.length) return "match"
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
      let name = stringOrUndef(fm.name)
      if (!name) {
        const fallback = nameFromFilename(file.filename)
        if (fallback) name = fallback
      }

      const minErr = ensureMinimum(file, name, parsed.body)
      if (minErr) {
        errors.push(minErr)
        continue
      }

      drafts.push(
        buildDraft({
          source: "cline",
          file,
          name: name as string,
          description: stringOrUndef(fm.description),
          systemPrompt: parsed.body,
          rawFrontmatter: Object.keys(fm).length > 0 ? fm : undefined,
          warnings,
        })
      )
    }

    return { drafts, errors }
  },
}

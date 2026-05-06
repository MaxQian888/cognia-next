// Cursor rules adapter.
//
// Source files: `.cursor/rules/<name>.mdc` — strictly speaking a "rule" not a
// subagent, but the body is functionally a system-prompt fragment, so we treat
// the rule as a subagent draft when imported through this dialog.
//
// Frontmatter shape:
//   ---
//   description: One-line description shown in Cursor.
//   globs: ["src/**/*.ts"]    # optional, retained in rawFrontmatter
//   alwaysApply: true          # optional
//   name: optional-name        # cognia extension; we default to filename
//   ---
//   Rule body — becomes systemPrompt.

import type { ImportInput, ParseResult, SubagentImportDraft, SubagentSourceAdapter } from "./types"
import {
  buildDraft,
  ensureMinimum,
  fileMatchesAnyExt,
  nameFromFilename,
  parseFrontmatter,
  stringOrUndef,
} from "./_parse-helpers"

const ACCEPTED = [".mdc", ".md"]
const PATH_HINT = ".cursor/rules"

export const cursorAdapter: SubagentSourceAdapter = {
  id: "cursor",
  displayName: "Cursor",
  labelKey: "cursor",
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
        if (fallback) {
          name = fallback
          // Cursor rules rarely carry a name field — silent fallback.
        }
      }

      const minErr = ensureMinimum(file, name, parsed.body)
      if (minErr) {
        errors.push(minErr)
        continue
      }

      drafts.push(
        buildDraft({
          source: "cursor",
          file,
          name: name as string,
          description: stringOrUndef(fm.description),
          systemPrompt: parsed.body,
          rawFrontmatter: fm,
          warnings,
        })
      )
    }

    return { drafts, errors }
  },
}

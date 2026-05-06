// Claude Code subagent adapter.
//
// Source files: `.claude/agents/<name>.md` (project) and
// `~/.claude/agents/<name>.md` (user).
//
// Frontmatter shape:
//   ---
//   name: code-reviewer
//   description: Reviews code for quality and correctness.
//   tools: Read, Grep, Glob          # optional, comma-list or array
//   model: sonnet                    # optional, sonnet|opus|haiku|inherit
//   ---
//   System prompt body...

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

const ACCEPTED = [".md", ".markdown"]
const PATH_HINT = ".claude/agents/"

export const claudeCodeAdapter: SubagentSourceAdapter = {
  id: "claude-code",
  displayName: "Claude Code",
  labelKey: "claude-code",
  acceptedExtensions: ACCEPTED,

  detect(input) {
    const hits = input.files.filter(
      (f) =>
        fileMatchesAnyExt(f.filename, ACCEPTED) &&
        f.sourcePath.replace(/\\/g, "/").includes(PATH_HINT)
    )
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
          warnings.push(`No 'name' in frontmatter — using "${name}".`)
        }
      }

      const minErr = ensureMinimum(file, name, parsed.body)
      if (minErr) {
        errors.push(minErr)
        continue
      }

      const description = stringOrUndef(fm.description)
      const tools = parseList(fm.tools)
      const model = stringOrUndef(fm.model)

      drafts.push(
        buildDraft({
          source: "claude-code",
          file,
          name: name as string,
          description,
          systemPrompt: parsed.body,
          tools,
          model,
          providerHint: "anthropic",
          rawFrontmatter: fm,
          warnings,
        })
      )
    }

    return { drafts, errors }
  },
}

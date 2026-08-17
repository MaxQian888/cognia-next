// Pi subagent adapter (ADR-0119).
//
// Source files: `<repo>/.pi/agents/<name>.md` (project) and
// `<pi agent dir>/agents/<name>.md` (user, when present).
//
// Frontmatter shape, taken from the agents this repo itself ships:
//   ---
//   description: Read-only correctness, security, and regression reviewer
//   display_name: Reviewer
//   tools: read, grep, find, ls, bash     # comma list, lowercase tool ids
//   thinking: high                        # low | medium | high
//   max_turns: 12
//   prompt_mode: append                   # append | replace
//   inherit_context: true
//   run_in_background: true
//   permission:
//     "*": deny
//     read: allow
//     bash: ask
//   ---
//   System prompt body...
//
// Two differences from every other adapter here matter:
//
//   - **There is no `name` field.** Pi identifies an agent by its filename and
//     uses `display_name` only for presentation, so the filename is the
//     identity rather than a fallback, and a missing `display_name` is not a
//     warning.
//   - **`permission` has no Cognia equivalent.** Pi enforces a per-tool
//     allow/ask/deny map on the subagent; Cognia's subagent model carries a
//     tool list, not a policy. Dropping it silently would import an agent that
//     looks identical but is materially more permissive, so it is reported as
//     a warning and retained in `rawFrontmatter`.

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
const PATH_HINT = ".pi/agents/"

/** Pi's thinking levels; anything else is passed through with a warning. */
const THINKING_LEVELS = new Set(["low", "medium", "high"])

export const piAdapter: SubagentSourceAdapter = {
  id: "pi",
  displayName: "Pi",
  labelKey: "pi",
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

      // Filename is the identity in Pi, not a fallback for a missing field.
      const name = nameFromFilename(file.filename)

      const minErr = ensureMinimum(file, name, parsed.body)
      if (minErr) {
        errors.push(minErr)
        continue
      }

      const description = stringOrUndef(fm.description) ?? stringOrUndef(fm.display_name)
      const tools = parseList(fm.tools)

      const thinking = stringOrUndef(fm.thinking)
      if (thinking && !THINKING_LEVELS.has(thinking.toLowerCase())) {
        warnings.push(`Unknown thinking level "${thinking}" — imported as-is.`)
      }

      if (fm.permission && typeof fm.permission === "object") {
        warnings.push(
          "Pi's per-tool permission policy has no Cognia equivalent and was not imported — " +
            "review this agent's tool access before running it."
        )
      }
      if (fm.run_in_background === true) {
        warnings.push("`run_in_background` is a Pi runtime flag and was not imported.")
      }

      drafts.push(
        buildDraft({
          source: "pi",
          file,
          name,
          description,
          systemPrompt: parsed.body,
          tools,
          // Pi picks the model per session, not per agent — there is no model
          // field to map, and inventing one would misreport the import.
          model: undefined,
          rawFrontmatter: fm,
          warnings,
        })
      )
    }

    return { drafts, errors }
  },
}

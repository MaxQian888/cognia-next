// Pi prompt-template adapter (ADR-0119).
//
// Source dir: `<pi agent dir>/prompts/` (user) and `<repo>/.pi/prompts/`
// (project). Pi renamed `commands/` to `prompts/` — its own installer still
// ships a `migrateCommandsToPrompts` step — so only `prompts/` is read here.
//
// This does not reuse `parseCommandMarkdown`: that helper emits warnings
// naming OpenCode's `agent`/`subtask` frontmatter, which would be simply wrong
// text on a Pi template.

import { parseFrontmatter, stringOrUndef } from "@/lib/claude/subagent-importers/_parse-helpers"
import { commandNameFromPath, type CommandImportDraft, type CommandSourceFile } from "./types"

/**
 * Pi expands `$ARGUMENTS` / `$1`… inside a template at invocation time. Cognia
 * custom commands have their own argument model, so a template relying on them
 * is imported verbatim with a warning rather than silently losing its
 * placeholders.
 */
const PI_ARG_TOKEN = /\$(ARGUMENTS\b|\d)/

export function commandsFromPiFiles(
  root: string,
  files: readonly CommandSourceFile[]
): CommandImportDraft[] {
  return files.map((file) => {
    const name = commandNameFromPath(root, file.path)
    const parsed = parseFrontmatter(file.content)
    const body = parsed.body.trim()
    const warnings: string[] = []

    if (PI_ARG_TOKEN.test(body)) {
      warnings.push(
        "This template uses Pi argument placeholders ($ARGUMENTS / $1). They are imported " +
          "verbatim — check them against Cognia's command arguments before use."
      )
    }

    return {
      id: `pi:${name}`,
      source: "pi",
      sourcePath: file.path,
      name,
      description: stringOrUndef(parsed.data.description),
      model: stringOrUndef(parsed.data.model),
      body,
      warnings,
      shared: false,
    }
  })
}

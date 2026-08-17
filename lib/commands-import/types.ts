import { parseFrontmatter, stringOrUndef } from "@/lib/claude/subagent-importers/_parse-helpers"

export type CommandsSourceId = "claude-code" | "codex" | "opencode" | "pi"
export type CommandImportMergeStrategy = "skip" | "overwrite" | "duplicate"

export interface CommandSourceFile {
  path: string
  content: string
}

export interface CommandImportDraft {
  id: string
  source: CommandsSourceId
  sourcePath: string
  name: string
  description?: string
  model?: string
  body: string
  warnings: string[]
  shared: boolean
}

export interface CommandsImportPreview {
  source: CommandsSourceId
  shared: boolean
  drafts: CommandImportDraft[]
  warnings: string[]
}

export function commandNameFromPath(root: string, path: string): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "")
  const normalizedPath = path.replace(/\\/g, "/")
  const relative = normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1)
  return relative.replace(/\.(md|markdown)$/i, "")
}

export function parseCommandMarkdown(
  source: Exclude<CommandsSourceId, "claude-code">,
  sourcePath: string,
  name: string,
  content: string
): CommandImportDraft {
  const parsed = parseFrontmatter(content)
  const warnings: string[] = []
  for (const key of ["agent", "subtask"] as const) {
    if (parsed.data[key] !== undefined) {
      warnings.push(`OpenCode ${key} metadata is not represented by Cognia custom commands.`)
    }
  }
  return {
    id: `${source}:${name}`,
    source,
    sourcePath,
    name,
    description: stringOrUndef(parsed.data.description),
    model: stringOrUndef(parsed.data.model),
    body: parsed.body.trim(),
    warnings,
    shared: false,
  }
}

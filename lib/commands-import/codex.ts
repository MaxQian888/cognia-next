import {
  commandNameFromPath,
  parseCommandMarkdown,
  type CommandImportDraft,
  type CommandSourceFile,
} from "./types"

export function commandsFromCodexFiles(
  root: string,
  files: readonly CommandSourceFile[]
): CommandImportDraft[] {
  return files.map((file) =>
    parseCommandMarkdown("codex", file.path, commandNameFromPath(root, file.path), file.content)
  )
}

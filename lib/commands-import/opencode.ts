import {
  commandNameFromPath,
  parseCommandMarkdown,
  type CommandImportDraft,
  type CommandSourceFile,
} from "./types"

export function commandsFromOpencodeFiles(
  root: string,
  files: readonly CommandSourceFile[]
): CommandImportDraft[] {
  return files.map((file) =>
    parseCommandMarkdown("opencode", file.path, commandNameFromPath(root, file.path), file.content)
  )
}

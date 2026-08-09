import { joinPath } from "@/lib/claude/instructions/paths"
import type { VendorRoots } from "@/lib/agent-roots"
import type { SessionFs } from "@/lib/session-import/types"
import { commandsFromCodexFiles } from "./codex"
import { commandsFromOpencodeFiles } from "./opencode"
import type { CommandsImportPreview, CommandsSourceId, CommandSourceFile } from "./types"

export interface CommandsImportPreviewDeps {
  roots: () => Promise<VendorRoots>
  fs: SessionFs
  walkFiles: (
    fs: SessionFs,
    root: string,
    predicate: (name: string) => boolean
  ) => Promise<string[]>
}

async function defaultDeps(): Promise<CommandsImportPreviewDeps> {
  const [{ resolveVendorRoots }, { realSessionFs, walkFiles }] = await Promise.all([
    import("@/lib/agent-roots"),
    import("@/lib/session-import/fs"),
  ])
  return { roots: resolveVendorRoots, fs: realSessionFs(), walkFiles }
}

export async function previewCommandsImport(
  source: CommandsSourceId,
  deps?: CommandsImportPreviewDeps
): Promise<CommandsImportPreview> {
  if (source === "claude-code") {
    return { source, shared: true, drafts: [], warnings: [] }
  }
  const resolved = deps ?? (await defaultDeps())
  const roots = await resolved.roots()
  const baseRoot = source === "codex" ? roots.codexHome : roots.opencodeConfigDir
  if (!baseRoot) {
    return { source, shared: false, drafts: [], warnings: ["Source root is unavailable."] }
  }
  const root = source === "codex" ? joinPath(baseRoot, "prompts") : joinPath(baseRoot, "commands")
  const paths = await resolved.walkFiles(resolved.fs, root, (name) =>
    /\.(md|markdown)$/i.test(name)
  )
  const files: CommandSourceFile[] = []
  const warnings: string[] = []
  for (const path of paths) {
    try {
      files.push({ path, content: await resolved.fs.readTextFile(path) })
    } catch (error) {
      warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const drafts =
    source === "codex"
      ? commandsFromCodexFiles(root, files)
      : commandsFromOpencodeFiles(root, files)
  return { source, shared: false, drafts, warnings }
}

export * from "./types"

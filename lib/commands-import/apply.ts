import type { SaveCustomCommandInput } from "@/lib/slash-commands/custom"
import type { CommandImportDraft, CommandImportMergeStrategy } from "./types"

export interface ApplyCommandsImportDeps {
  listExisting: () => Promise<Array<{ name: string }>>
  save: (input: SaveCustomCommandInput) => Promise<string>
  refresh: () => Promise<unknown>
}

export interface ApplyCommandsImportResult {
  imported: number
  updated: number
  skipped: number
  failed: Array<{ name: string; error: string }>
  warnings: string[]
}

async function defaultDeps(): Promise<ApplyCommandsImportDeps> {
  const commands = await import("@/lib/slash-commands/custom")
  return {
    listExisting: () => commands.loadCustomSlashCommands(null),
    save: commands.saveCustomSlashCommand,
    refresh: () => commands.loadCustomSlashCommands(null),
  }
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base.toLowerCase())) return base
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${base}-${Date.now()}`
}

export async function applyCommandsImport(
  drafts: readonly CommandImportDraft[],
  strategy: CommandImportMergeStrategy,
  deps?: ApplyCommandsImportDeps
): Promise<ApplyCommandsImportResult> {
  const resolved = deps ?? (await defaultDeps())
  const existing = await resolved.listExisting()
  const taken = new Set(existing.map((command) => command.name.toLowerCase()))
  const result: ApplyCommandsImportResult = {
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: [],
    warnings: drafts.flatMap((draft) => draft.warnings),
  }

  for (const draft of drafts) {
    if (draft.shared) {
      result.skipped += 1
      continue
    }
    const conflict = taken.has(draft.name.toLowerCase())
    if (conflict && strategy === "skip") {
      result.skipped += 1
      continue
    }
    const name = conflict && strategy === "duplicate" ? uniqueName(draft.name, taken) : draft.name
    try {
      await resolved.save({
        scope: "user",
        name,
        description: draft.description,
        model: draft.model,
        body: draft.body,
      })
      taken.add(name.toLowerCase())
      if (conflict && strategy === "overwrite") result.updated += 1
      else result.imported += 1
    } catch (error) {
      result.failed.push({
        name: draft.name,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (result.imported > 0 || result.updated > 0) await resolved.refresh()
  return result
}

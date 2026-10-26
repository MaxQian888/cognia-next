/**
 * Instruction files (AGENTS.md / CLAUDE.md / AGENT.md, the global
 * `~/.cognia/<name>`, `.cognia/instructions/*.md`) as Prompt Center resources
 * (ADR-0236 §5.1).
 *
 * The file is the authority. The list is the same discovery a turn uses
 * (`discoverProjectInstructionFiles`), so the editor shows exactly the files
 * that load, in load order. Reads return the raw text and the hash of the bytes
 * read; a save is a checked write against that hash (or against absence for a
 * file being created), so a change made on disk since the read is a conflict,
 * never an overwrite. `@import` lines are text like any other: the file is
 * edited, not its expansion. Only hosts with a project filesystem list files.
 */

import {
  clearInstructionCache,
  discoverProjectInstructionFiles,
} from "@/lib/claude/instructions/load"
import { basename, dirname, joinPath } from "@/lib/claude/instructions/paths"
import { resolveInstructionsConfig, type InstructionSource } from "@/lib/claude/instructions/types"
import { readWorkspaceFileVersioned, writeWorkspaceFileChecked } from "@/lib/files/workspace-fs"
import { useSettingsStore } from "@/stores/settings"
import {
  parseResourceKey,
  resourceKey,
  type OwnerPromptAdapter,
  type OwnerPromptDocument,
  type PromptResourceContext,
  type PromptResourceSummary,
} from "../resources"

/** Precondition a document carries while its file does not exist yet. */
export const ABSENT_FILE_VERSION = "absent"

export interface InstructionFileRef {
  /** Directory the checked write is rooted at (the file's own directory). */
  root: string
  /** File name inside `root`. */
  name: string
}

export function instructionFileKey(ref: InstructionFileRef): string {
  return resourceKey(
    "instruction-file",
    `${encodeURIComponent(ref.root)}|${encodeURIComponent(ref.name)}`
  )
}

export function parseInstructionFileKey(key: string): InstructionFileRef {
  const { source, id } = parseResourceKey(key)
  const [root, name] = id.split("|")
  if (source !== "instruction-file" || !root || !name) {
    throw new Error(`not an instruction file resource: ${key}`)
  }
  return { root: decodeURIComponent(root), name: decodeURIComponent(name) }
}

function refFor(absPath: string): InstructionFileRef {
  return { root: dirname(absPath), name: basename(absPath) }
}

export interface InstructionFileAdapterDeps {
  /** Discovery; defaults to the send path's own. */
  discover?: typeof discoverProjectInstructionFiles
  read?: typeof readWorkspaceFileVersioned
  write?: typeof writeWorkspaceFileChecked
  /** Whether a path exists; distinguishes "not created yet" from a failed read. */
  exists?: (path: string) => Promise<boolean>
}

async function defaultExists(path: string): Promise<boolean> {
  const { exists } = await import("@/lib/file/file-operations")
  return exists(path)
}

function summary(
  absPath: string,
  label: string,
  source: InstructionSource | "new"
): PromptResourceSummary {
  return {
    key: instructionFileKey(refFor(absPath)),
    source: "instruction-file",
    kind: "project-rule",
    operation: "append-rules",
    name: label,
    builtIn: false,
    modified: source !== "new",
    edit: "source",
    ownerSection: "agent-runtime",
    detail: source === "new" ? undefined : source,
  }
}

export function createInstructionFilePromptAdapter(
  deps: InstructionFileAdapterDeps = {}
): OwnerPromptAdapter {
  const discover = deps.discover ?? discoverProjectInstructionFiles
  const read = deps.read ?? readWorkspaceFileVersioned
  const write = deps.write ?? writeWorkspaceFileChecked
  const exists = deps.exists ?? defaultExists

  async function readDocument(key: string): Promise<OwnerPromptDocument> {
    const ref = parseInstructionFileKey(key)
    try {
      const file = await read(ref.root, ref.name)
      return { key, text: file.content, version: file.sha256 }
    } catch (error) {
      if (await exists(joinPath(ref.root, ref.name)).catch(() => true)) throw error
      return { key, text: "", version: ABSENT_FILE_VERSION }
    }
  }

  return {
    source: "instruction-file",

    async list(ctx: PromptResourceContext) {
      const roots = ctx.workspace?.roots ?? []
      const config = useSettingsStore.getState().settings?.instructions
      const found = await discover({ cwd: roots[0], roots: [...roots], config })
      const listed = found.map((file) => summary(file.absPath, file.label, file.source))
      // A workspace with no instruction file of its own is offered the first
      // configured name at its root, which a save creates.
      const primary = roots[0]
      const hasProjectFile = found.some((file) => file.source === "project")
      if (primary && !hasProjectFile) {
        const [firstName] = resolveInstructionsConfig(config).fileNames
        if (firstName) listed.push(summary(joinPath(primary, firstName), firstName, "new"))
      }
      return listed
    },

    read: (key) => readDocument(key),

    async save(key, text, version) {
      const ref = parseInstructionFileKey(key)
      if (!version) throw new Error("a file is saved against the version it was read at")
      await write(
        ref.root,
        ref.name,
        text,
        version === ABSENT_FILE_VERSION ? { expectAbsent: true } : { expectedSha256: version }
      )
      // The send path memoizes the rendered section for a few seconds.
      clearInstructionCache()
      return readDocument(key)
    },
  }
}

export const instructionFilePromptAdapter = createInstructionFilePromptAdapter()

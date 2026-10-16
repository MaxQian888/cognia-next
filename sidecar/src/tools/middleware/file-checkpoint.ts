// Pre-mutation file snapshots for a host-side rewind (`/rewind` in the CLI TUI).
//
// The host keeps each file's original bytes so a rewind can put them back. It
// used to read the file itself when it saw the tool-call event, which is too
// late: an auto-approved write runs here while that event is still streaming,
// so the "original" it read could already be the new content. This module
// reads the targets after the permission gate has allowed a call and before
// the tool runs, and ships the bytes in one `file_pre_mutation` frame. Frames
// leave on one ordered stdout, so the host holds the snapshot before any later
// frame of the call (including a sandboxed tool's own `plugin_tool_exec`).
//
// Opt-in per session (`sendOptions.fileCheckpointFrames`): only a host that
// rewinds files should pay for reading and encoding them.

import fs from "node:fs"
import path from "node:path"

import { parsePatch } from "diff"

import { resolveToolPath } from "../../platform/fs/paths.ts"
import { BUILTIN_SERVER_NAME } from "../../policy/tool-catalog/catalog.ts"
import { PLUGIN_TOOLS_SERVER_NAME, splitToolName } from "../../policy/tool-catalog/names.ts"

/** The largest single file a snapshot carries. */
export const SNAPSHOT_FILE_LIMIT_BYTES = 16 * 1024 * 1024
/** The most bytes one tool call's snapshot carries in total. */
export const SNAPSHOT_CALL_LIMIT_BYTES = 64 * 1024 * 1024
/** The most entries a recursive directory snapshot walks. */
export const SNAPSHOT_TREE_ENTRY_LIMIT = 5_000

/** One path a mutating call is about to change. */
export interface MutationTarget {
  path: string
  /** A recursive delete: everything beneath the path is snapshotted too. */
  recursive?: boolean
  /** Only snapshot when the path lies inside the session's workspace roots. */
  workspaceOnly?: boolean
}

/** What stood at one path before the call. */
export interface PreMutationEntry {
  path: string
  before: "file" | "absent" | "directory"
  /** The file's bytes, base64; present for a captured `file`. */
  contentBase64?: string
  /** Why the entry cannot be restored; the host reports it instead. */
  omitted?: "too-large" | "unreadable" | "outside-workspace"
}

export interface PreMutationFrame {
  type: "file_pre_mutation"
  sessionId: string
  toolName: string
  entries: PreMutationEntry[]
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

function patchTargets(patch: unknown, cwd: string | undefined): MutationTarget[] {
  if (typeof patch !== "string") return []
  let files: ReturnType<typeof parsePatch>
  try {
    files = parsePatch(patch)
  } catch {
    // The tool rejects the same text before writing anything.
    return []
  }
  const out: MutationTarget[] = []
  for (const file of files) {
    for (const name of [file.oldFileName, file.newFileName]) {
      if (!name || name === "/dev/null") continue
      out.push({ path: resolveToolPath(cwd, name.replace(/^[ab]\//, "")) })
    }
  }
  return out
}

/**
 * The paths a call will change, or `null` when the tool does not write files
 * this module can snapshot. Built-in names are the `cognia-tools` server's;
 * the sandboxed editors are the first-party `cognia-sandboxed-tools` plugin's.
 */
export function mutationTargets(
  toolName: string,
  input: unknown,
  cwd: string | undefined
): MutationTarget[] | null {
  const { server, bare } = splitToolName(toolName)
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const at = (...keys: string[]): MutationTarget[] =>
    keys.flatMap((key) => {
      const value = str(args[key])
      return value ? [{ path: resolveToolPath(cwd, value) }] : []
    })
  if (server === null || server === BUILTIN_SERVER_NAME) {
    switch (bare) {
      case "write":
      case "edit":
      case "multi_edit":
      case "NotebookEdit":
        return at("file_path")
      case "apply_patch":
        return patchTargets(args.patch, cwd)
      case "file_append":
      case "file_binary_write":
      case "directory_create":
        return at("path")
      case "file_copy":
        return at("destination")
      case "file_move":
        return at("source", "destination")
      case "file_rename":
        return at("oldPath", "newPath")
      case "directory_delete": {
        const value = str(args.path)
        return value
          ? [{ path: resolveToolPath(cwd, value), recursive: args.recursive === true }]
          : []
      }
    }
  }
  if (server === null || server === PLUGIN_TOOLS_SERVER_NAME) {
    // These run wherever the sandbox placement runs; a path is only the host's
    // own file when it sits inside the workspace the host shares with it.
    const sandboxed = (targets: MutationTarget[]) =>
      targets.map((target) => ({ ...target, workspaceOnly: true }))
    switch (bare) {
      case "sandbox_write":
      case "sandbox_edit":
        return sandboxed(at("path"))
      case "sandbox_text_editor":
        return args.command === "view" ? null : sandboxed(at("path"))
    }
  }
  return null
}

function within(roots: readonly string[], target: string): boolean {
  return roots.some((root) => {
    const rel = path.relative(root, target)
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
  })
}

/**
 * Read what stands at each target now. Never throws: a path that cannot be
 * read is reported as `omitted`, so the host can say it will not come back.
 */
export function snapshotTargets(
  targets: readonly MutationTarget[],
  {
    workspaceRoots = [],
    fileLimitBytes = SNAPSHOT_FILE_LIMIT_BYTES,
    callLimitBytes = SNAPSHOT_CALL_LIMIT_BYTES,
    treeEntryLimit = SNAPSHOT_TREE_ENTRY_LIMIT,
  }: {
    workspaceRoots?: readonly string[]
    fileLimitBytes?: number
    callLimitBytes?: number
    treeEntryLimit?: number
  } = {}
): PreMutationEntry[] {
  const roots = workspaceRoots.map((root) => path.resolve(root))
  const entries: PreMutationEntry[] = []
  const seen = new Set<string>()
  let budget = callLimitBytes

  const captureFile = (file: string, size: number): PreMutationEntry => {
    if (size > fileLimitBytes || size > budget) {
      return { path: file, before: "file", omitted: "too-large" }
    }
    try {
      const bytes = fs.readFileSync(file)
      budget -= bytes.byteLength
      return { path: file, before: "file", contentBase64: bytes.toString("base64") }
    } catch {
      return { path: file, before: "file", omitted: "unreadable" }
    }
  }

  /** Every directory and file beneath `dir`, or null past the entry limit. */
  const walk = (dir: string): Array<{ path: string; isDir: boolean; size: number }> | null => {
    const found: Array<{ path: string; isDir: boolean; size: number }> = []
    const pending = [dir]
    while (pending.length > 0) {
      const current = pending.pop()!
      let names: fs.Dirent[]
      try {
        names = fs.readdirSync(current, { withFileTypes: true })
      } catch {
        return null
      }
      for (const dirent of names) {
        const full = path.join(current, dirent.name)
        if (found.length >= treeEntryLimit) return null
        if (dirent.isDirectory()) {
          found.push({ path: full, isDir: true, size: 0 })
          pending.push(full)
        } else {
          let size = 0
          try {
            size = fs.statSync(full).size
          } catch {
            size = 0
          }
          found.push({ path: full, isDir: false, size })
        }
      }
    }
    return found
  }

  for (const target of targets) {
    const abs = path.resolve(target.path)
    if (seen.has(abs)) continue
    seen.add(abs)
    if (target.workspaceOnly && !within(roots, abs)) {
      entries.push({ path: abs, before: "absent", omitted: "outside-workspace" })
      continue
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      entries.push(
        code === "ENOENT" || code === "ENOTDIR"
          ? { path: abs, before: "absent" }
          : { path: abs, before: "file", omitted: "unreadable" }
      )
      continue
    }
    if (!stat.isDirectory()) {
      entries.push(captureFile(abs, stat.size))
      continue
    }
    if (!target.recursive) {
      entries.push({ path: abs, before: "directory" })
      continue
    }
    const tree = walk(abs)
    if (!tree || tree.reduce((sum, item) => sum + item.size, 0) > budget) {
      // A partial tree would restore some files and silently lose the rest.
      entries.push({ path: abs, before: "directory", omitted: "too-large" })
      continue
    }
    entries.push({ path: abs, before: "directory" })
    for (const item of tree) {
      seen.add(item.path)
      entries.push(
        item.isDir ? { path: item.path, before: "directory" } : captureFile(item.path, item.size)
      )
    }
  }
  return entries
}

/**
 * Build the reporter the tool gate calls once a call is allowed. Emits nothing
 * for tools that write no files, and never throws into the tool call.
 */
export function createPreMutationReporter({
  emit,
  sessionId,
  cwd,
  workspaceRoots,
  log,
}: {
  emit: (frame: PreMutationFrame) => void
  sessionId: string
  cwd: string | undefined
  workspaceRoots: readonly string[]
  log?: (level: string, message: string) => void
}): (toolName: string, input: unknown) => void {
  return (toolName, input) => {
    try {
      const targets = mutationTargets(toolName, input, cwd)
      if (!targets || targets.length === 0) return
      const entries = snapshotTargets(targets, { workspaceRoots })
      if (entries.length > 0) emit({ type: "file_pre_mutation", sessionId, toolName, entries })
    } catch (error) {
      log?.(
        "warn",
        `file checkpoint snapshot failed for ${toolName}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}

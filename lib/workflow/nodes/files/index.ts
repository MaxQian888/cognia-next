/**
 * Workspace filesystem action nodes: `action.fs.{read,write,list,stat,search,
 * mkdir,move,copy,delete}`.
 *
 * Until these existed, a graph could not read or write a file at all. The
 * sidecar's `file-ops` tools belong to the *agent*, so moving one file cost an
 * `action.agent.turn` and an LLM round trip, and `action.system.terminal` was
 * the only other way in: a `pty` capability and a shell string to parse.
 *
 * Built on `lib/files/workspace-fs.ts`, which is the seam that makes these
 * portable. Every call there goes through `transport.call` rather than a raw
 * `invoke`, and the ten `fs_*_workspace` commands the nodes use are classified
 * `execution` in the command manifest, so a desktop routing to a remote Host
 * (ADR-0082) reaches that Host's disk with no work here. The one exception is
 * `fs_walk_workspace`, which is registered only as a local Tauri command. See
 * `canWalkWorkspace` below.
 *
 * NOT built on `createFileSystemAPI` (`lib/plugin/core/context.ts`). That seam
 * confines every op to `<install_dir>/<pluginId>/data/`, so it is a per-plugin
 * scratch sandbox rather than the user's workspace, and reaching it would mean
 * inventing a plugin id to borrow a permission gate that was never granted.
 */

import {
  copyWorkspaceEntry,
  createWorkspaceDir,
  deleteWorkspaceEntry,
  listWorkspaceDir,
  readWorkspaceFile,
  renameWorkspaceEntry,
  searchWorkspaceContent,
  statWorkspaceFile,
  walkWorkspace,
  writeWorkspaceFile,
} from "@/lib/files/workspace-fs"
import { searchWorkspace } from "@/lib/files/workspace-search"
import { detectPlatform } from "@/lib/platform/detect"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import type { WorkspaceEntry } from "@/lib/files/types"
import type { StepExecutionContext } from "@/types/workflow/visual"
import { registerNodeExecutor } from "../registry"
import { nonRetryable } from "../shared/executor-support"
import { optionalRelPath, requireRelPath, resolveFsRoot } from "./root"

/**
 * Default and ceiling for `action.fs.read`.
 *
 * The ceiling is tied to `HOST_DISPATCH_MAX_RESULT_CHARS` so a payload that
 * fits in a local step output also survives a hop to another Host, instead of
 * succeeding on a desktop and truncating in the middle of a placed run.
 */
export const FS_READ_DEFAULT_MAX_BYTES = 1024 * 1024
export const FS_READ_CEILING_BYTES = 8 * 1024 * 1024

/** Caps for the degraded recursive listing. Mirrors `walkWorkspace`'s own. */
const LIST_DEFAULT_MAX_ENTRIES = 5_000
const LIST_CEILING_MAX_ENTRIES = 50_000
const LIST_DEFAULT_MAX_DEPTH = 24

/**
 * Whether `fs_walk_workspace` can be reached from here.
 *
 * It is the one export of `workspace-fs.ts` that does not honour that module's
 * own header: registered at `src-tauri/src/lib.rs` and nowhere else, absent
 * from the companion RPC allowlist, from the generated command index, and from
 * the `workspace.files` operation list in the host feature manifest. Calling it
 * anyway would hand the author a raw `unknown_command` from the wire, so
 * `action.fs.list` degrades to a bounded breadth-first walk built out of
 * `fs_list_workspace_dir`, which every Host answers.
 */
export function canWalkWorkspace(): boolean {
  return detectPlatform() === "tauri" && !isRemoteHostActive()
}

function params(ctx: StepExecutionContext): Record<string, unknown> {
  return ctx.params as Record<string, unknown>
}

function boolOf(p: Record<string, unknown>, key: string): boolean | undefined {
  return typeof p[key] === "boolean" ? (p[key] as boolean) : undefined
}

function intOf(p: Record<string, unknown>, key: string): number | undefined {
  const value = p[key]
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.floor(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Translate a Host refusal into something an author can act on.
 *
 * Two refusals reach these nodes as opaque strings and both have a real
 * remedy, so neither should surface raw:
 *
 *  - a non-UTF-8 file. `fs_read_workspace_file` is `read_to_string`, and there
 *    is no binary read on this seam at all (`transport.readBinary` is typed to
 *    session media), so "read that file some other way" is not advice, it is
 *    the whole answer.
 *  - `interactive_approval_required`. The five write commands carry
 *    `approval: interactive` and require an admin lease on the device plane.
 *    A workflow step is background work, and ADR-0153 exists precisely so a
 *    remote client cannot approve itself, so the node says where to run
 *    instead. It never mints a lease.
 */
function translateHostRefusal(err: unknown, kind: string): never {
  const message = err instanceof Error ? err.message : String(err)
  if (/valid UTF-8/i.test(message)) {
    throw nonRetryable(
      `${kind}: that file is not UTF-8 text. This seam has no binary read, so read it ` +
        `from a terminal or agent step instead. (fs.not-text)`
    )
  }
  if (/interactive_approval_required|adminLease|428/i.test(message)) {
    throw nonRetryable(
      `${kind}: the Host refused an unattended write. Writes need an interactive ` +
        `approval lease when they come from a paired device, so run this workflow on ` +
        `the Host that owns the files, or grant this device remote control.`
    )
  }
  throw err
}

// ── Reads ───────────────────────────────────────────────────────────────────

registerNodeExecutor({
  kind: "action.fs.read",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const { root, mode } = await resolveFsRoot(ctx)
    const relPath = requireRelPath(p, "relPath", "action.fs.read")
    const maxBytes = clamp(
      intOf(p, "maxBytes") ?? FS_READ_DEFAULT_MAX_BYTES,
      1,
      FS_READ_CEILING_BYTES
    )

    // Stat first. A read that is refused after the bytes are already in the
    // renderer has already paid the cost the cap exists to avoid, and the
    // event log is written verbatim with no truncation of its own.
    const stat = await statWorkspaceFile(root, relPath)
    if (!stat.exists) throw nonRetryable(`action.fs.read: ${relPath} does not exist under ${root}`)
    if (stat.isDir) throw nonRetryable(`action.fs.read: ${relPath} is a directory`)
    if (stat.size > maxBytes) {
      throw nonRetryable(
        `action.fs.read: ${relPath} is ${stat.size} bytes, over the ${maxBytes}-byte cap. ` +
          `Raise maxBytes (ceiling ${FS_READ_CEILING_BYTES}) or read a smaller file.`
      )
    }

    let content: string
    try {
      content = await readWorkspaceFile(root, relPath, maxBytes)
    } catch (err) {
      translateHostRefusal(err, "action.fs.read")
    }
    return {
      output: {
        root,
        rootMode: mode,
        relPath,
        content,
        byteLength: stat.size,
        // Derived from the stat, not from the "... (truncated)" marker Rust
        // appends: `lib/file-viewer/probe.ts` documents that the marker is not
        // something a caller may lean on.
        truncated: stat.size > maxBytes,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.fs.stat",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const { root, mode } = await resolveFsRoot(ctx)
    const relPath = requireRelPath(p, "relPath", "action.fs.stat")
    const stat = await statWorkspaceFile(root, relPath)
    return { output: { root, rootMode: mode, relPath, ...stat } }
  },
})

registerNodeExecutor({
  kind: "action.fs.list",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const { root, mode } = await resolveFsRoot(ctx)
    const relPath = optionalRelPath(p, "relPath", "action.fs.list")
    const includeIgnored = boolOf(p, "includeIgnored")
    const recursive = boolOf(p, "recursive") ?? false

    if (!recursive) {
      const entries = await listWorkspaceDir(root, relPath, includeIgnored)
      return {
        output: {
          root,
          rootMode: mode,
          relPath: relPath ?? "",
          recursive: false,
          entries: entries.map(toListedEntry),
          entryCount: entries.length,
          truncated: false,
          skippedSensitive: 0,
          degraded: false,
        },
      }
    }

    const maxEntries = clamp(
      intOf(p, "maxEntries") ?? LIST_DEFAULT_MAX_ENTRIES,
      1,
      LIST_CEILING_MAX_ENTRIES
    )
    const maxDepth = clamp(intOf(p, "maxDepth") ?? LIST_DEFAULT_MAX_DEPTH, 1, 64)
    const includeDirs = boolOf(p, "includeDirs") ?? false

    if (canWalkWorkspace()) {
      const walk = await walkWorkspace(root, {
        relPath,
        includeIgnored,
        includeDirs,
        maxEntries,
        maxDepth,
      })
      return {
        output: {
          root,
          rootMode: mode,
          relPath: relPath ?? "",
          recursive: true,
          entries: walk.entries.map(toListedEntry),
          entryCount: walk.entries.length,
          truncated: walk.truncated,
          skippedSensitive: walk.skippedSensitive,
          degraded: false,
        },
      }
    }

    const degraded = await breadthFirstList(root, relPath, {
      includeIgnored,
      includeDirs,
      maxEntries,
      maxDepth,
    })
    return {
      output: {
        root,
        rootMode: mode,
        relPath: relPath ?? "",
        recursive: true,
        entries: degraded.entries.map(toListedEntry),
        entryCount: degraded.entries.length,
        truncated: degraded.truncated,
        // The depth-1 command applies its own floors but does not report a
        // count, so this stays 0 rather than claiming a number it did not get.
        skippedSensitive: 0,
        degraded: true,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.fs.search",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const { root, mode } = await resolveFsRoot(ctx)
    const query = typeof p.query === "string" ? p.query : ""
    if (query.trim().length === 0) throw nonRetryable("action.fs.search requires 'query'")
    const target = p.target === "name" ? "name" : "content"
    const maxResults = clamp(intOf(p, "maxResults") ?? 100, 1, 500)

    if (target === "name") {
      const entries = await searchWorkspace(root, query, maxResults)
      return {
        output: {
          root,
          rootMode: mode,
          target,
          query,
          matches: entries.map(toListedEntry),
          matchCount: entries.length,
        },
      }
    }

    const matches = await searchWorkspaceContent(root, query, {
      isRegex: boolOf(p, "isRegex"),
      caseSensitive: boolOf(p, "caseSensitive"),
      maxResults,
    })
    return {
      output: {
        root,
        rootMode: mode,
        target,
        query,
        matches: matches.map((m) => ({
          relPath: m.relPath,
          line: m.line,
          column: m.column,
          preview: m.preview,
        })),
        matchCount: matches.length,
      },
    }
  },
})

// ── Writes ──────────────────────────────────────────────────────────────────

registerNodeExecutor({
  kind: "action.fs.write",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const { root, mode } = await resolveFsRoot(ctx)
    const relPath = requireRelPath(p, "relPath", "action.fs.write")
    const content = typeof p.content === "string" ? p.content : undefined
    if (content === undefined) throw nonRetryable("action.fs.write requires 'content'")
    const writeMode = p.mode === "append" ? "append" : "overwrite"

    let next = content
    let previousBytes = 0
    if (writeMode === "append") {
      // There is no atomic append on this seam, so append is read-concat-write
      // and the node says so in its description rather than implying otherwise.
      const stat = await statWorkspaceFile(root, relPath)
      if (stat.exists && stat.isDir) {
        throw nonRetryable(`action.fs.write: ${relPath} is a directory`)
      }
      if (stat.exists) {
        if (stat.size > FS_READ_CEILING_BYTES) {
          throw nonRetryable(
            `action.fs.write: cannot append to ${relPath}, it is ${stat.size} bytes and ` +
              `append has to read the file first (ceiling ${FS_READ_CEILING_BYTES}).`
          )
        }
        try {
          const existing = await readWorkspaceFile(root, relPath, FS_READ_CEILING_BYTES)
          previousBytes = stat.size
          next = existing + content
        } catch (err) {
          translateHostRefusal(err, "action.fs.write")
        }
      }
    }

    try {
      await writeWorkspaceFile(root, relPath, next)
    } catch (err) {
      translateHostRefusal(err, "action.fs.write")
    }
    return {
      output: {
        root,
        rootMode: mode,
        relPath,
        mode: writeMode,
        byteLength: next.length,
        previousBytes,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.fs.mkdir",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const { root, mode } = await resolveFsRoot(ctx)
    const relPath = requireRelPath(p, "relPath", "action.fs.mkdir")
    try {
      await createWorkspaceDir(root, relPath)
    } catch (err) {
      translateHostRefusal(err, "action.fs.mkdir")
    }
    return { output: { root, rootMode: mode, relPath, created: true } }
  },
})

registerNodeExecutor({
  kind: "action.fs.move",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const { root, mode } = await resolveFsRoot(ctx)
    const fromRelPath = requireRelPath(p, "fromRelPath", "action.fs.move")
    const toRelPath = requireRelPath(p, "toRelPath", "action.fs.move")
    try {
      await renameWorkspaceEntry(root, fromRelPath, toRelPath)
    } catch (err) {
      translateHostRefusal(err, "action.fs.move")
    }
    return { output: { root, rootMode: mode, fromRelPath, toRelPath, moved: true } }
  },
})

registerNodeExecutor({
  kind: "action.fs.copy",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const { root, mode } = await resolveFsRoot(ctx)
    const fromRelPath = requireRelPath(p, "fromRelPath", "action.fs.copy")
    const toRelPath = requireRelPath(p, "toRelPath", "action.fs.copy")
    const recursive = boolOf(p, "recursive")
    try {
      await copyWorkspaceEntry(root, fromRelPath, toRelPath, recursive)
    } catch (err) {
      translateHostRefusal(err, "action.fs.copy")
    }
    return { output: { root, rootMode: mode, fromRelPath, toRelPath, copied: true } }
  },
})

registerNodeExecutor({
  kind: "action.fs.delete",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const { root, mode } = await resolveFsRoot(ctx)
    const relPath = requireRelPath(p, "relPath", "action.fs.delete")
    const recursive = boolOf(p, "recursive")
    try {
      await deleteWorkspaceEntry(root, relPath, recursive)
    } catch (err) {
      translateHostRefusal(err, "action.fs.delete")
    }
    return { output: { root, rootMode: mode, relPath, deleted: true } }
  },
})

// ── Helpers ─────────────────────────────────────────────────────────────────

interface ListedEntry {
  relPath: string
  isDir: boolean
  size: number
  mtimeMs: number | null
}

/**
 * Project a workspace entry for a step output.
 *
 * `absolutePath` is dropped on purpose. It is the one field that means
 * something different on every Host, so carrying it downstream invites a
 * workflow to feed a desktop path back into a step that runs on the brain.
 */
function toListedEntry(entry: WorkspaceEntry): ListedEntry {
  return {
    relPath: entry.relPath,
    isDir: entry.isDir,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
  }
}

interface BreadthFirstOptions {
  includeIgnored?: boolean
  includeDirs: boolean
  maxEntries: number
  maxDepth: number
}

/**
 * Recursive listing built from the depth-1 command, for Hosts that cannot
 * answer `fs_walk_workspace`.
 *
 * Breadth-first so a cap truncates the deepest level rather than an arbitrary
 * subtree, which is the same shape `walkWorkspace` reports.
 */
async function breadthFirstList(
  root: string,
  relPath: string | undefined,
  options: BreadthFirstOptions
): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
  const entries: WorkspaceEntry[] = []
  let queue: Array<{ path: string | undefined; depth: number }> = [{ path: relPath, depth: 0 }]
  let truncated = false

  while (queue.length > 0) {
    const next: Array<{ path: string | undefined; depth: number }> = []
    for (const dir of queue) {
      const children = await listWorkspaceDir(root, dir.path, options.includeIgnored)
      for (const child of children) {
        if (child.isDir) {
          if (options.includeDirs) {
            if (entries.length >= options.maxEntries) return { entries, truncated: true }
            entries.push(child)
          }
          if (dir.depth + 1 < options.maxDepth)
            next.push({ path: child.relPath, depth: dir.depth + 1 })
          else truncated = true
        } else {
          if (entries.length >= options.maxEntries) return { entries, truncated: true }
          entries.push(child)
        }
      }
    }
    queue = next
  }
  return { entries, truncated }
}

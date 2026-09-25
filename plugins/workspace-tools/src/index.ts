/**
 * Workspace Tools — built-in plugin.
 *
 * Three read-only agent tools (and matching workflow nodes) over the project
 * the user has open:
 *   * `workspace_list_files` — list the immediate children of a directory
 *   * `workspace_read_file`  — read a UTF-8 text file
 *   * `workspace_search`     — regex search across text files
 *
 * Every call resolves the project root afresh through
 * `ctx.workspace.getActiveRoot()` — a root captured at activation went stale
 * the moment the user switched projects — and reads through the host's
 * workspace API (`ctx.workspace.acquire` / `walk` / `read`), whose Rust side
 * canonicalizes each path and refuses one that resolves outside the root
 * (symlinks included) and withholds credential files. The plugin adds a
 * lexical `..` check in front so a traversal attempt gets a clear refusal
 * before any host call.
 *
 * Desktop only (manifest `runtimeCompatibility`): the browser build and the
 * mobile shell have no project filesystem to read.
 */

import {
  definePlugin,
  definePluginManifest,
  definePluginTool,
  defineWorkflowNode,
  type PluginContext,
  type PluginNodeDef,
  type PluginToolRegistration,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import {
  checkSearchPattern,
  SEARCH_MAX_PATTERN_LENGTH,
  SEARCH_MAX_TESTED_LINE_CHARS,
} from "./regex-guard"

type WorkspaceAPI = PluginContext["workspace"]
type WorkspaceHandle = Awaited<ReturnType<WorkspaceAPI["acquire"]>>
type WorkspaceEntry = Awaited<ReturnType<WorkspaceAPI["walk"]>>["entries"][number]

type Failure = { ok: false; error: string }

function failure(error: string): Failure {
  return { ok: false, error }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const NO_WORKSPACE = failure(
  "No project is open. Open a project folder first — Workspace Tools only read inside it."
)
const CANCELLED = failure("The call was cancelled.")

/** Most entries one listing returns. */
export const LIST_MAX_ENTRIES = 2_000
/** Default and ceiling for `workspace_read_file`'s `maxBytes`. */
export const READ_DEFAULT_MAX_BYTES = 64 * 1024
export const READ_MAX_RETURN_BYTES = 1024 * 1024
/**
 * Files above this are refused before reading: the host reads a file whole
 * before truncating it, so a multi-GB file would be loaded just to return the
 * first 64 KiB.
 */
export const READ_MAX_FILE_BYTES = 8 * 1024 * 1024
/** Directory entries scanned when sizing a file before reading it. */
const READ_SIZE_PROBE_ENTRIES = 50_000

/**
 * Bounds for `workspace_search`. It is a line-by-line JS regex over files read
 * one by one, so it must stay cheap: a model can call it freely, and an
 * unbounded sweep of a real project is minutes of wall-clock.
 */
export const SEARCH_SKIP_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  "vendor",
  "coverage",
  "__pycache__",
])
export const SEARCH_MAX_DEPTH = 12
export const SEARCH_MAX_FILES = 5_000
export const SEARCH_MAX_FILE_BYTES = 512 * 1024
export const SEARCH_MAX_MATCHES = 200
export const SEARCH_READ_CONCURRENCY = 4
/** Wall-clock the search may spend before it returns what it has. */
export const SEARCH_TIME_BUDGET_MS = 40_000
/** Tool budget: the search budget plus room to walk and answer. */
export const SEARCH_TOOL_TIMEOUT_MS = 60_000

type TruncationReason =
  "max-files" | "max-matches" | "oversized-files" | "skipped-directories" | "time-budget"

function normalise(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/g, "")
}

function basename(relPath: string): string {
  return relPath.split("/").pop() ?? relPath
}

/**
 * Resolve a tool-supplied path against the project root and REJECT anything
 * that lands outside it. Lexical only — the host's canonicalizing check (which
 * also catches symlinks) runs on every read and walk after this.
 */
export function resolveInWorkspace(
  root: string,
  input: unknown
): { ok: true; path: string; rel: string } | Failure {
  if (input !== undefined && input !== null && typeof input !== "string") {
    return failure("path must be a string")
  }
  const base = normalise(root)
  const raw = (input ?? ".").trim() || "."
  const candidate = normalise(raw)
  const isAbsolute = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(raw)
  const joined = isAbsolute ? candidate : `${base}/${candidate.replace(/^\.\//, "")}`

  const parts: string[] = []
  for (const segment of joined.split("/")) {
    if (segment === "." || segment === "") continue
    if (segment === "..") {
      if (parts.length === 0) return failure(`Path escapes the workspace: ${raw}`)
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  const resolved = (joined.startsWith("/") ? "/" : "") + parts.join("/")
  if (resolved !== base && !resolved.startsWith(`${base}/`)) {
    return failure(`Path escapes the workspace: ${raw}`)
  }
  return { ok: true, path: resolved, rel: resolved === base ? "" : resolved.slice(base.length + 1) }
}

/** A positive integer argument, clamped to `max`; `fallback` when absent. */
function boundedInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback
  return Math.min(max, Math.floor(value))
}

/**
 * One workspace session per plugin activation: the root is read per call, and
 * the host handle for it is reused until the root changes.
 */
export function createWorkspaceReader(workspace: WorkspaceAPI) {
  let cached: { root: string; handle: Promise<WorkspaceHandle> } | null = null

  function handleFor(root: string): Promise<WorkspaceHandle> {
    if (cached?.root !== root) {
      const handle = workspace.acquire({ kind: "local-path", path: root })
      const entry = { root, handle }
      cached = entry
      // A failed acquire must not poison later calls for the same root.
      handle.catch(() => {
        if (cached === entry) cached = null
      })
    }
    return cached.handle
  }

  /** The active root and a handle onto it, or the reason there is none. */
  async function open(
    input: unknown
  ): Promise<
    { ok: true; handle: WorkspaceHandle; root: string; path: string; rel: string } | Failure
  > {
    const root = workspace.getActiveRoot()
    if (!root) return NO_WORKSPACE
    const resolved = resolveInWorkspace(root, input)
    if (!resolved.ok) return resolved
    return {
      ok: true,
      handle: await handleFor(root),
      root: normalise(root),
      path: resolved.path,
      rel: resolved.rel,
    }
  }

  async function listFiles(args: Record<string, unknown>): Promise<unknown> {
    try {
      const target = await open(args.path)
      if (!target.ok) return target
      const walk = await workspace.walk(target.handle, {
        ...(target.rel ? { relPath: target.rel } : {}),
        includeDirs: true,
        // A listing mirrors the directory: git-ignored entries are shown.
        includeIgnored: true,
        maxDepth: 1,
        maxEntries: LIST_MAX_ENTRIES,
      })
      return {
        ok: true as const,
        path: target.path,
        entries: walk.entries.map((entry) => ({
          name: basename(entry.relPath),
          isDirectory: entry.isDir,
          isFile: !entry.isDir,
          ...(entry.isDir ? {} : { size: entry.size }),
        })),
        truncated: walk.truncated,
        ...(walk.skippedSensitive > 0 ? { withheldCredentialFiles: walk.skippedSensitive } : {}),
      }
    } catch (err) {
      return failure(`workspace_list_files: ${errorMessage(err)}`)
    }
  }

  /** Size a file BEFORE reading it, by listing its folder one level deep. */
  async function sizeOf(
    handle: WorkspaceHandle,
    rel: string
  ): Promise<{ ok: true; size: number } | Failure> {
    const slash = rel.lastIndexOf("/")
    const parent = slash === -1 ? "" : rel.slice(0, slash)
    const name = rel.slice(slash + 1)
    const probe = await workspace.walk(handle, {
      ...(parent ? { relPath: parent } : {}),
      includeDirs: true,
      includeIgnored: true,
      maxDepth: 1,
      maxEntries: READ_SIZE_PROBE_ENTRIES,
    })
    // Match by name inside the probed folder: `relPath` is reported against
    // the canonical root, which differs from the caller's path when a folder
    // on the way is an in-workspace symlink.
    const entry: WorkspaceEntry | undefined = probe.entries.find(
      (candidate) => basename(candidate.relPath) === name
    )
    if (entry?.isDir) return failure(`${rel} is a directory — use workspace_list_files`)
    if (entry) return { ok: true, size: entry.size }
    if (probe.truncated) {
      return failure(`${rel} could not be sized: its folder has too many entries to scan`)
    }
    return failure(
      `No readable file at ${rel}. It does not exist, or the host withholds it as a credential file.`
    )
  }

  async function readFile(args: Record<string, unknown>): Promise<unknown> {
    if (typeof args.path !== "string" || !args.path.trim()) return failure("path is required")
    try {
      const target = await open(args.path)
      if (!target.ok) return target
      if (!target.rel) return failure(`${target.path} is a directory — use workspace_list_files`)
      const sized = await sizeOf(target.handle, target.rel)
      if (!sized.ok) return sized
      if (sized.size > READ_MAX_FILE_BYTES) {
        return failure(
          `${target.path} is ${sized.size} bytes, over the ${READ_MAX_FILE_BYTES}-byte read limit — search it with workspace_search instead`
        )
      }
      const cap = boundedInteger(args.maxBytes, READ_DEFAULT_MAX_BYTES, READ_MAX_RETURN_BYTES)
      const content = await workspace.read(target.handle, target.rel, { maxBytes: cap })
      if (content === null) return failure(`${target.path} could not be read`)
      return {
        ok: true as const,
        path: target.path,
        size: sized.size,
        content,
        truncated: sized.size > cap,
      }
    } catch (err) {
      return failure(`workspace_read_file: ${errorMessage(err)}`)
    }
  }

  async function search(
    args: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    const pattern = args.pattern
    if (typeof pattern !== "string" || pattern.length === 0) {
      return failure("pattern is required")
    }
    const guard = checkSearchPattern(pattern)
    if (!guard.ok) return failure(`Unsupported regex pattern: ${guard.error}`)
    let re: RegExp
    try {
      re = new RegExp(pattern, args.ignoreCase === true ? "i" : "")
    } catch (err) {
      return failure(`Invalid regex pattern: ${errorMessage(err)}`)
    }
    if (signal?.aborted) return CANCELLED

    try {
      const target = await open(args.path)
      if (!target.ok) return target
      const deadline = Date.now() + SEARCH_TIME_BUDGET_MS
      const truncated = new Set<TruncationReason>()
      const walk = await workspace.walk(target.handle, {
        ...(target.rel ? { relPath: target.rel } : {}),
        maxDepth: SEARCH_MAX_DEPTH,
        maxEntries: SEARCH_MAX_FILES,
      })
      if (walk.truncated) truncated.add("max-files")

      const prefix = target.rel ? `${target.rel}/` : ""
      const files = walk.entries.filter((entry) => {
        if (entry.isDir) return false
        // Relative to the search root, so searching INSIDE `dist/` still works.
        const segments = entry.relPath.startsWith(prefix)
          ? entry.relPath.slice(prefix.length).split("/")
          : entry.relPath.split("/")
        const dirs = segments.slice(0, -1)
        if (dirs.some((dir) => dir.startsWith(".") || SEARCH_SKIP_DIRS.has(dir))) {
          truncated.add("skipped-directories")
          return false
        }
        // Sized by the walk, so an oversized file is skipped WITHOUT reading it.
        if (entry.size > SEARCH_MAX_FILE_BYTES) {
          truncated.add("oversized-files")
          return false
        }
        return true
      })

      const matches: Array<{ path: string; line: number; text: string }> = []
      let next = 0
      const stop = () =>
        signal?.aborted === true ||
        matches.length >= SEARCH_MAX_MATCHES ||
        truncated.has("time-budget")

      const worker = async () => {
        while (next < files.length && !stop()) {
          if (Date.now() > deadline) {
            truncated.add("time-budget")
            return
          }
          const entry = files[next++]
          let body: string | null
          try {
            body = await workspace.read(target.handle, entry.relPath, {
              maxBytes: SEARCH_MAX_FILE_BYTES,
            })
          } catch {
            continue // binary / unreadable files are not search hits
          }
          if (body === null || stop()) continue
          const lines = body.split(/\r?\n/)
          for (let index = 0; index < lines.length; index++) {
            if (index % 500 === 0 && Date.now() > deadline) {
              truncated.add("time-budget")
              return
            }
            const line = lines[index]
            if (re.test(line.slice(0, SEARCH_MAX_TESTED_LINE_CHARS))) {
              matches.push({
                path: `${target.root}/${entry.relPath}`,
                line: index + 1,
                text: line.slice(0, 200),
              })
              if (matches.length >= SEARCH_MAX_MATCHES) {
                truncated.add("max-matches")
                return
              }
            }
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(SEARCH_READ_CONCURRENCY, Math.max(1, files.length)) }, worker)
      )
      if (signal?.aborted) return CANCELLED

      // Report the bounds instead of silently presenting a partial sweep as complete.
      return {
        ok: true as const,
        pattern,
        matches,
        truncated: truncated.size > 0,
        ...(truncated.size > 0 ? { truncatedReasons: [...truncated].sort() } : {}),
        ...(walk.skippedSensitive > 0 ? { withheldCredentialFiles: walk.skippedSensitive } : {}),
      }
    } catch (err) {
      return failure(`workspace_search: ${errorMessage(err)}`)
    }
  }

  return { listFiles, readFile, search }
}

type WorkspaceReader = ReturnType<typeof createWorkspaceReader>

/**
 * One JSON Schema per operation, shared by the workflow node (inspector form)
 * and the agent tool (model-facing contract), so the model always sees real
 * parameter names.
 */
export const LIST_FILES_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Project-relative directory path. Defaults to the project root.",
    },
  },
  additionalProperties: false,
}

export const READ_FILE_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Project-relative file path to read.",
    },
    maxBytes: {
      type: "integer",
      minimum: 1,
      maximum: READ_MAX_RETURN_BYTES,
      description: `Maximum bytes of text returned. Defaults to ${READ_DEFAULT_MAX_BYTES}.`,
    },
  },
  required: ["path"],
  additionalProperties: false,
}

export const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      maxLength: SEARCH_MAX_PATTERN_LENGTH,
      description:
        "JavaScript regular expression, matched line by line. Nested quantifiers such as (a+)+ and backreferences are refused.",
    },
    path: {
      type: "string",
      description: "Project-relative folder to search. Defaults to the project root.",
    },
    ignoreCase: {
      type: "boolean",
      description: "Search case-insensitively.",
    },
  },
  required: ["pattern"],
  additionalProperties: false,
}

export const WORKSPACE_TOOL_NAMES = [
  "workspace_list_files",
  "workspace_read_file",
  "workspace_search",
] as const

export function buildWorkspaceTools(reader: WorkspaceReader): PluginToolRegistration[] {
  return [
    definePluginTool({
      name: "workspace_list_files",
      definition: {
        name: "workspace_list_files",
        description:
          "List the immediate children of a folder in the open project (defaults to the project root), with file sizes. Git-ignored entries are included; credential files are withheld.",
        access: "read",
        pathParams: ["path"],
        parametersSchema: LIST_FILES_SCHEMA,
      },
      execute: (args) => reader.listFiles(args),
    }),
    definePluginTool({
      name: "workspace_read_file",
      definition: {
        name: "workspace_read_file",
        description: `Read a UTF-8 text file in the open project. maxBytes caps the returned text (default ${READ_DEFAULT_MAX_BYTES}); files over ${READ_MAX_FILE_BYTES} bytes are refused.`,
        access: "read",
        pathParams: ["path"],
        parametersSchema: READ_FILE_SCHEMA,
      },
      execute: (args) => reader.readFile(args),
    }),
    definePluginTool({
      name: "workspace_search",
      definition: {
        name: "workspace_search",
        description: `Search text files in the open project for a JavaScript regular expression, line by line. Honours .gitignore, skips dependency/build and dot folders and files over ${SEARCH_MAX_FILE_BYTES} bytes, and stops at ${SEARCH_MAX_MATCHES} matches or ${SEARCH_TIME_BUDGET_MS / 1000} s — check \`truncated\`.`,
        access: "read",
        pathParams: ["path"],
        timeoutMs: SEARCH_TOOL_TIMEOUT_MS,
        parametersSchema: SEARCH_SCHEMA,
      },
      execute: (args, callCtx) => reader.search(args, callCtx.signal),
    }),
  ]
}

/**
 * Workflow nodes for the same three abilities. Labels here are the English
 * fallback; plugin.json localizes them under `workflow.nodes.<kind>.*`.
 */
export function buildWorkspaceNodes(reader: WorkspaceReader): PluginNodeDef[] {
  return [
    defineWorkflowNode({
      kind: "action.listFiles",
      typeVersion: 1,
      category: "plugin",
      label: "List workspace files",
      description: "List immediate children of a workspace directory.",
      iconName: "FolderTree",
      keywords: ["workspace", "files", "list", "directory", "project"],
      desktopOnly: true,
      paramsSchema: LIST_FILES_SCHEMA,
      defaultParams: { path: "." },
      execute: async (ctx) => ({ output: await reader.listFiles(ctx.params ?? {}) }),
    }),
    defineWorkflowNode({
      kind: "action.readFile",
      typeVersion: 1,
      category: "plugin",
      label: "Read workspace file",
      description: "Read a UTF-8 text file from the workspace.",
      iconName: "FileText",
      keywords: ["workspace", "file", "read", "text", "project"],
      desktopOnly: true,
      paramsSchema: READ_FILE_SCHEMA,
      defaultParams: { path: "", maxBytes: READ_DEFAULT_MAX_BYTES },
      execute: async (ctx) => ({ output: await reader.readFile(ctx.params ?? {}) }),
    }),
    defineWorkflowNode({
      kind: "action.search",
      typeVersion: 1,
      category: "plugin",
      label: "Search workspace",
      description: "Search workspace files for a regular-expression pattern.",
      iconName: "Search",
      keywords: ["workspace", "search", "grep", "regex", "project"],
      desktopOnly: true,
      timeoutMs: SEARCH_TOOL_TIMEOUT_MS,
      paramsSchema: SEARCH_SCHEMA,
      defaultParams: { pattern: "", path: ".", ignoreCase: false },
      execute: async (ctx) => ({ output: await reader.search(ctx.params ?? {}, ctx.signal) }),
    }),
  ]
}

// plugin.json is the manifest source of truth; tools and workflow nodes
// register imperatively in `activate`.
export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  activate: (ctx) => {
    const reader = createWorkspaceReader(ctx.workspace)
    for (const tool of buildWorkspaceTools(reader)) ctx.agent.registerTool(tool)
    for (const node of buildWorkspaceNodes(reader)) {
      ctx.lifecycle.onDispose(ctx.workflow.registerNode(node), `workspace-tools:${node.kind}`)
    }
    ctx.logger.info("workspace-tools activated")
  },
})

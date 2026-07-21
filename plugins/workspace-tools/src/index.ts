/**
 * Workspace Tools — built-in plugin.
 *
 * Surfaces three agent tools that read the current working directory:
 *   * `workspace_list_files` — list immediate children of a path
 *   * `workspace_read_file`  — read a UTF-8 text file
 *   * `workspace_search`     — grep-like search across the workspace
 *
 * In browser mode every tool returns a `desktop-only` diagnostic instead of
 * throwing `runtime.browser.unsupported`. Desktop runs route through Tauri
 * filesystem APIs so the manager can grant `filesystem:read` per the
 * manifest.
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { defineWorkflowNode } from "@cognia/plugin-sdk"
// `isTauri` retained as fallback when host doesn't expose
// `ctx.capabilities` (ADR-0026 §5 §C migration path).
import { isTauri } from "@/lib/tauri"

interface ListFilesArgs {
  path?: string
  recursive?: boolean
}

interface ReadFileArgs {
  path: string
  maxBytes?: number
}

interface SearchArgs {
  pattern: string
  path?: string
  ignoreCase?: boolean
}

const DESKTOP_ONLY = {
  ok: false as const,
  error: "Workspace Tools require the desktop app for filesystem access.",
}

const NO_WORKSPACE = {
  ok: false as const,
  error:
    "No workspace is open. Open a folder in Source Control — Workspace Tools only read inside it.",
}

/**
 * Resolve the open workspace root, mirroring the CLI-tools executor's
 * `getWorkspaceRoot` (`lib/plugin/cli-tools/execute-cli-tool.ts`). Lazily
 * required so the project store stays out of non-UI bundles.
 */
function workspaceRoot(): string | undefined {
  if (workspaceRootOverride !== undefined) return workspaceRootOverride ?? undefined
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useProjectStore } = require("@/stores/project/project-store") as {
      useProjectStore: {
        getState: () => {
          activeProjectId: string | null
          projects: Array<{ id: string; roots?: unknown }>
        }
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { primaryRootOf } = require("@/lib/workspace/roots") as {
      primaryRootOf: (p: { roots?: unknown }) => { path?: string } | undefined
    }
    const state = useProjectStore.getState()
    const project = state.activeProjectId
      ? state.projects.find((p) => p.id === state.activeProjectId)
      : undefined
    return project ? primaryRootOf(project)?.path : undefined
  } catch {
    return undefined
  }
}

/** Test seam: `null` = "no workspace open", a string = that root. */
let workspaceRootOverride: string | null | undefined

/** @internal test-only */
export function __setWorkspaceRootForTesting(root: string | null | undefined): void {
  workspaceRootOverride = root
}

function normalise(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/g, "")
}

/**
 * Resolve a tool-supplied path against the workspace root and REJECT anything
 * that lands outside it.
 *
 * These tools import `@tauri-apps/plugin-fs` directly rather than going through
 * `ctx.fs` — and they have to: `ctx.fs` confines every path to
 * `<plugin_dir>/data` (`resolve_scoped` in `crates/cognia-plugin-runtime`),
 * which is the plugin's private data dir, not the user's workspace. That means
 * the declared `filesystem:read` permission does no gating here, so the
 * confinement has to be enforced in the plugin. Without it
 * `workspace_read_file` happily read `/etc/passwd` or `~/.ssh/id_rsa` — a
 * read-anything primitive reachable through prompt injection.
 */
function resolveInWorkspace(
  input: string | undefined
): { ok: true; path: string; root: string } | { ok: false; error: string } {
  const root = workspaceRoot()
  if (!root) return { ok: false, error: NO_WORKSPACE.error }
  const base = normalise(root)
  const raw = (input ?? ".").trim() || "."
  const candidate = normalise(raw)
  const isAbsolute = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(raw)
  const joined = isAbsolute ? candidate : `${base}/${candidate.replace(/^\.\//, "")}`

  // Collapse `.` / `..` textually — the Tauri fs API takes the string as-is.
  const parts: string[] = []
  for (const segment of joined.split("/")) {
    if (segment === "." || segment === "") continue
    if (segment === "..") {
      if (parts.length === 0) return { ok: false, error: `Path escapes the workspace: ${raw}` }
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  const resolved = (joined.startsWith("/") ? "/" : "") + parts.join("/")
  if (resolved !== base && !resolved.startsWith(`${base}/`)) {
    return { ok: false, error: `Path escapes the workspace: ${raw}` }
  }
  return { ok: true, path: resolved, root: base }
}

/**
 * Cached `tauri` flag — set by `activate()` from `ctx.capabilities.tauri`
 * when the host exposes ADR-0026 §5 §C, otherwise falls back to the
 * direct `isTauri()` import. Module-scoped so the tool executors (which
 * don't receive the plugin context as an argument) can read it without
 * threading `ctx` through every call site.
 */
let tauriHostFlag: boolean | undefined
let disposeWorkflowNodes: Array<() => void> = []

function resolveTauriHost(): boolean {
  if (tauriHostFlag !== undefined) return tauriHostFlag
  return isTauri()
}

async function listFiles(args: ListFilesArgs): Promise<unknown> {
  if (!resolveTauriHost()) return DESKTOP_ONLY
  const resolved = resolveInWorkspace(args.path)
  if (!resolved.ok) return { ok: false as const, error: resolved.error }
  const fs = await import("@tauri-apps/plugin-fs")
  const path = resolved.path
  const entries = await fs.readDir(path)
  return {
    ok: true as const,
    path,
    entries: entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory ?? false,
      isFile: e.isFile ?? false,
    })),
  }
}

async function readFile(args: ReadFileArgs): Promise<unknown> {
  if (!resolveTauriHost()) return DESKTOP_ONLY
  if (!args.path) {
    return { ok: false as const, error: "path is required" }
  }
  const resolved = resolveInWorkspace(args.path)
  if (!resolved.ok) return { ok: false as const, error: resolved.error }
  const fs = await import("@tauri-apps/plugin-fs")
  const text = await fs.readTextFile(resolved.path)
  const cap = args.maxBytes && args.maxBytes > 0 ? args.maxBytes : 64 * 1024
  return {
    ok: true as const,
    path: resolved.path,
    content: text.length > cap ? text.slice(0, cap) : text,
    truncated: text.length > cap,
  }
}

/**
 * Bounds for `workspace_search`. This is a naive JS walk (the repo ships
 * `plugins/ripgrep-tools` for real searching), so it must stay cheap: a model
 * can call it freely, and an unbounded sweep of a real project is minutes of
 * wall-clock plus every dependency file loaded into a string.
 */
const SEARCH_SKIP_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  "vendor",
  "coverage",
  "__pycache__",
])
const SEARCH_MAX_DEPTH = 12
const SEARCH_MAX_FILE_CHARS = 512 * 1024
const SEARCH_MAX_MATCHES = 200

async function search(args: SearchArgs): Promise<unknown> {
  if (!resolveTauriHost()) return DESKTOP_ONLY
  if (!args.pattern) {
    return { ok: false as const, error: "pattern is required" }
  }
  const resolvedRoot = resolveInWorkspace(args.path)
  if (!resolvedRoot.ok) return { ok: false as const, error: resolvedRoot.error }
  const fs = await import("@tauri-apps/plugin-fs")
  const root = resolvedRoot.path
  const flags = args.ignoreCase ? "i" : ""
  let re: RegExp
  try {
    re = new RegExp(args.pattern, flags)
  } catch (err) {
    return {
      ok: false as const,
      error: `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const matches: Array<{ path: string; line: number; text: string }> = []
  let truncated = false

  async function walk(dir: string, depth: number) {
    if (depth > SEARCH_MAX_DEPTH) {
      truncated = true
      return
    }
    const entries = await fs.readDir(dir)
    for (const entry of entries) {
      const child = `${dir}/${entry.name}`
      if (entry.isDirectory) {
        // Dot-directories were the ONLY exclusion, so a search rooted at a real
        // project descended into node_modules / target / dist and read every
        // file in them as UTF-8 — minutes of wall-clock and hundreds of MB for
        // a tool the model can call freely.
        if (!entry.name || entry.name.startsWith(".") || SEARCH_SKIP_DIRS.has(entry.name)) {
          continue
        }
        await walk(child, depth + 1)
      } else if (entry.isFile && entry.name) {
        try {
          const body = await fs.readTextFile(child)
          if (body.length > SEARCH_MAX_FILE_CHARS) {
            // Almost always a bundle, lockfile, or binary read as text.
            truncated = true
            continue
          }
          body.split(/\r?\n/).forEach((line, idx) => {
            if (re.test(line)) {
              matches.push({ path: child, line: idx + 1, text: line.slice(0, 200) })
            }
          })
        } catch {
          // skip binary / unreadable files
        }
      }
      if (matches.length > SEARCH_MAX_MATCHES) {
        truncated = true
        return
      }
    }
  }

  await walk(root, 0)
  // Report the bound instead of silently presenting a partial sweep as complete.
  return { ok: true as const, pattern: args.pattern, matches, truncated }
}

/**
 * One JSON Schema per operation, shared by the workflow node (inspector form)
 * and the agent tool (model-facing contract). They were previously duplicated:
 * the nodes carried the real schema while the tools shipped
 * `{ properties: {}, additionalProperties: true }`, which
 * `sidecar-tools-bridge` forwards verbatim — so the model saw three tools with
 * NO parameter names and had to guess `path` / `pattern` / `ignoreCase` /
 * `maxBytes` from prose that never mentions most of them.
 */
const LIST_FILES_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Workspace-relative directory path. Defaults to the workspace root.",
    },
  },
  additionalProperties: false,
} as const

const READ_FILE_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Workspace-relative file path to read.",
    },
    maxBytes: {
      type: "number",
      minimum: 1,
      description: "Maximum characters returned. Defaults to 65536.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const

const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: "Regular expression pattern to find.",
    },
    path: {
      type: "string",
      description: "Workspace-relative root to search. Defaults to the workspace root.",
    },
    ignoreCase: {
      type: "boolean",
      description: "Search case-insensitively.",
    },
  },
  required: ["pattern"],
  additionalProperties: false,
} as const

const workspaceListFilesNode = defineWorkflowNode({
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
  execute: async (ctx) => ({ output: await listFiles((ctx.params ?? {}) as ListFilesArgs) }),
})

const workspaceReadFileNode = defineWorkflowNode({
  kind: "action.readFile",
  typeVersion: 1,
  category: "plugin",
  label: "Read workspace file",
  description: "Read a UTF-8 text file from the workspace.",
  iconName: "FileText",
  keywords: ["workspace", "file", "read", "text", "project"],
  desktopOnly: true,
  paramsSchema: READ_FILE_SCHEMA,
  defaultParams: { path: "", maxBytes: 65536 },
  execute: async (ctx) => ({
    output: await readFile((ctx.params ?? {}) as unknown as ReadFileArgs),
  }),
})

const workspaceSearchNode = defineWorkflowNode({
  kind: "action.search",
  typeVersion: 1,
  category: "plugin",
  label: "Search workspace",
  description: "Search workspace files for a regular-expression pattern.",
  iconName: "Search",
  keywords: ["workspace", "search", "grep", "regex", "project"],
  desktopOnly: true,
  paramsSchema: SEARCH_SCHEMA,
  defaultParams: { pattern: "", path: ".", ignoreCase: false },
  execute: async (ctx) => ({
    output: await search((ctx.params ?? {}) as unknown as SearchArgs),
  }),
})

const WORKSPACE_WORKFLOW_NODES = [
  workspaceListFilesNode,
  workspaceReadFileNode,
  workspaceSearchNode,
] as const

const definition: PluginDefinition = {
  manifest: {
    id: "cognia-workspace-tools",
    name: "Workspace Tools",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["tools", "workflow"],
    main: "src/index.ts",
  } as never,
  activate: async (ctx: PluginContext) => {
    for (const dispose of disposeWorkflowNodes) dispose()
    disposeWorkflowNodes = []
    // Resolve the platform once at activate time and cache for the
    // executors below. Prefer ADR-0026 §5 §C `ctx.capabilities.tauri`.
    tauriHostFlag = ctx.capabilities?.tauri ?? isTauri()
    ctx.logger?.info(
      `workspace-tools activated (${tauriHostFlag ? "desktop" : "browser fallback"})`
    )

    const tools: Array<{
      name: string
      describe: string
      schema: unknown
      run: (args: unknown) => Promise<unknown>
    }> = [
      {
        name: "workspace_list_files",
        describe: "List files in a workspace directory.",
        schema: LIST_FILES_SCHEMA,
        run: (args) => listFiles((args ?? {}) as ListFilesArgs),
      },
      {
        name: "workspace_read_file",
        describe: "Read a workspace text file (UTF-8). maxBytes caps the response.",
        schema: READ_FILE_SCHEMA,
        run: (args) => readFile((args ?? {}) as ReadFileArgs),
      },
      {
        name: "workspace_search",
        describe: "Search workspace files for a regex pattern.",
        schema: SEARCH_SCHEMA,
        run: (args) => search((args ?? {}) as SearchArgs),
      },
    ]

    for (const tool of tools) {
      ctx.agent?.registerTool?.({
        name: tool.name,
        pluginId: ctx.pluginId,
        definition: {
          name: tool.name,
          description: tool.describe,
          // Same schema the workflow node uses. `sidecar-tools-bridge` forwards
          // this verbatim as the MCP tool's jsonSchema, so an empty object here
          // means the model gets no parameter names at all.
          parametersSchema: tool.schema,
        } as never,
        execute: tool.run,
      })
    }

    disposeWorkflowNodes = WORKSPACE_WORKFLOW_NODES.map((node) => ctx.workflow.registerNode(node))
  },
  deactivate: async () => {
    // Tools are unregistered by the runtime when deactivate runs.
    // Reset the cached host flag so a subsequent reactivation re-resolves
    // it from `ctx.capabilities` cleanly.
    for (const dispose of disposeWorkflowNodes) dispose()
    disposeWorkflowNodes = []
    tauriHostFlag = undefined
  },
}

export default definition

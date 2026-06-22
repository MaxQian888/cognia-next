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
  const fs = await import("@tauri-apps/plugin-fs")
  const path = args.path && args.path.length > 0 ? args.path : "."
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
  const fs = await import("@tauri-apps/plugin-fs")
  const text = await fs.readTextFile(args.path)
  const cap = args.maxBytes && args.maxBytes > 0 ? args.maxBytes : 64 * 1024
  return {
    ok: true as const,
    path: args.path,
    content: text.length > cap ? text.slice(0, cap) : text,
    truncated: text.length > cap,
  }
}

async function search(args: SearchArgs): Promise<unknown> {
  if (!resolveTauriHost()) return DESKTOP_ONLY
  if (!args.pattern) {
    return { ok: false as const, error: "pattern is required" }
  }
  const fs = await import("@tauri-apps/plugin-fs")
  const root = args.path && args.path.length > 0 ? args.path : "."
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

  async function walk(dir: string) {
    const entries = await fs.readDir(dir)
    for (const entry of entries) {
      const child = `${dir}/${entry.name}`
      if (entry.isDirectory) {
        if (entry.name?.startsWith(".")) continue
        await walk(child)
      } else if (entry.isFile && entry.name) {
        try {
          const body = await fs.readTextFile(child)
          body.split(/\r?\n/).forEach((line, idx) => {
            if (re.test(line)) {
              matches.push({ path: child, line: idx + 1, text: line.slice(0, 200) })
            }
          })
        } catch {
          // skip binary / unreadable files
        }
      }
      if (matches.length > 200) return
    }
  }

  await walk(root)
  return { ok: true as const, pattern: args.pattern, matches }
}

const workspaceListFilesNode = defineWorkflowNode({
  kind: "action.listFiles",
  typeVersion: 1,
  category: "plugin",
  label: "List workspace files",
  description: "List immediate children of a workspace directory.",
  iconName: "FolderTree",
  keywords: ["workspace", "files", "list", "directory", "project"],
  desktopOnly: true,
  paramsSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative directory path. Defaults to the workspace root.",
      },
    },
    additionalProperties: false,
  },
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
  paramsSchema: {
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
  },
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
  paramsSchema: {
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
  },
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
      run: (args: unknown) => Promise<unknown>
    }> = [
      {
        name: "workspace_list_files",
        describe: "List files in a workspace directory.",
        run: (args) => listFiles((args ?? {}) as ListFilesArgs),
      },
      {
        name: "workspace_read_file",
        describe: "Read a workspace text file (UTF-8). maxBytes caps the response.",
        run: (args) => readFile((args ?? {}) as ReadFileArgs),
      },
      {
        name: "workspace_search",
        describe: "Search workspace files for a regex pattern.",
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
          parametersSchema: {
            type: "object",
            properties: {},
            additionalProperties: true,
          },
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

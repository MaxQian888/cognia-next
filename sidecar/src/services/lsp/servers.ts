// Agent-side LSP server registry helpers.
//
// The server LIST is no longer hard-coded here. The renderer resolves the
// unified config (builtin defaults ← user settings ← project `.cognia/lsp.json`,
// see `lib/lsp/resolve-config.ts`) and hands the flat list to the sidecar via
// `sendOptions.lsp.servers`. This module turns those plain config objects into
// runnable `ServerInfo`s (`buildServers`) and matches a file against them
// (`serversForFile`). The `nearestRoot` combinator — the one genuinely new
// piece of the agent LSP runtime — still lives here and is reused unchanged.
//
// Inspired by OpenCode's `packages/opencode/src/lsp/server.ts`:
//   - extension-match selects candidate servers,
//   - `nearestRoot(markers, { excludeMarkers })` resolves the workspace root,
//     where an exclude marker closer to the file disables this server for that
//     tree (e.g. `deno.json` disables tsserver so the Deno toolchain wins).

import fs from "node:fs"
import path from "node:path"

/** npm-provisioning metadata for the install ladder. */
export interface LspInstallSpec {
  npmPackage: string
  version?: string
}

/**
 * One server as the renderer resolved it into `sendOptions.lsp.servers`: the
 * fields the agent runtime reads from `LspServerConfig`
 * (packages/agent-config-types/src/lsp-config.ts). A root-side contract test
 * keeps that type assignable to this one.
 */
export interface LspServerEntry {
  id: string
  command: string
  args?: string[]
  env?: Record<string, string>
  extensions?: string[]
  filenames?: string[]
  rootMarkers?: string[]
  excludeRootMarkers?: string[]
  initializationOptions?: unknown
  settings?: Record<string, unknown>
  workspaceFolderRequired?: boolean
  install?: LspInstallSpec
  startupTimeout?: number
}

/**
 * `sendOptions.lsp`, as the renderer resolved it (`LspSendOptions` in the
 * same package file). `servers` is read through `buildServers`.
 */
export interface LspSendOptions {
  enabled?: boolean
  servers?: unknown
  installDir?: string
  autoInstall?: boolean
}

export interface RootContext {
  cwd?: string | undefined
}

/** The workspace root for a file, or undefined when this server does not apply. */
export type RootResolver = (filePath: string, ctx?: RootContext) => string | undefined

/** What to spawn for one root. */
export interface ServerCommand {
  command: string
  args?: string[]
  env?: Record<string, string> | undefined
  initializationOptions?: unknown
}

/** A runnable server built from one config entry. */
export interface ServerInfo {
  id: string
  /** Lower-cased, with leading dot. */
  extensions: string[]
  filenames: string[]
  root: RootResolver
  resolveCommand: (root: string, ctx?: RootContext) => ServerCommand
  settings?: Record<string, unknown> | undefined
  workspaceFolderRequired?: boolean | undefined
  install?: LspInstallSpec | undefined
  /** ms to wait for `initialize` before treating the spawn as failed. */
  startupTimeout?: number | undefined
}

/**
 * Build a root resolver that walks up from a file's directory toward the
 * agent cwd (inclusive). Returns the first directory containing one of
 * `markers`. If a directory contains one of `excludeMarkers`, this server
 * is considered inapplicable for that tree and the resolver returns
 * `undefined` (a higher-priority toolchain owns it).
 */
export function nearestRoot(
  markers: readonly string[],
  opts: { excludeMarkers?: readonly string[] } = {}
): RootResolver {
  const excludeMarkers = opts.excludeMarkers ?? []
  return (filePath, ctx = {}) => {
    const resolved = path.resolve(filePath)
    let dir = path.dirname(resolved)
    // Stop boundary: the agent cwd if it is an ancestor, else the fs root.
    const cwd = ctx.cwd ? path.resolve(ctx.cwd) : null
    const stop = cwd && isAncestor(cwd, dir) ? cwd : path.parse(resolved).root

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (excludeMarkers.some((m) => existsIn(dir, m))) return undefined
      if (markers.some((m) => existsIn(dir, m))) return dir
      if (dir === stop) break
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return undefined
  }
}

function existsIn(dir: string, marker: string): boolean {
  try {
    return fs.existsSync(path.join(dir, marker))
  } catch {
    return false
  }
}

/** True when `ancestor` is `dir` or a parent directory of `dir`. */
function isAncestor(ancestor: string, dir: string): boolean {
  const a = path.resolve(ancestor)
  const d = path.resolve(dir)
  if (a === d) return true
  const rel = path.relative(a, d)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

/**
 * Root resolver for a config entry. With `rootMarkers`, walks up looking for
 * them (honouring `excludeRootMarkers`). Without markers, the server is
 * workspace-agnostic, so it anchors at the agent cwd (falling back to the
 * file's own directory when no cwd is supplied).
 */
function rootResolverFor(cfg: LspServerEntry): RootResolver {
  const markers = cfg.rootMarkers ?? []
  if (markers.length === 0) {
    return (filePath, ctx = {}) => ctx.cwd ?? path.dirname(path.resolve(filePath))
  }
  return nearestRoot(markers, { excludeMarkers: cfg.excludeRootMarkers ?? [] })
}

/**
 * Turn the resolved config list (plain objects from `sendOptions.lsp.servers`)
 * into runnable `ServerInfo`s. Entries with no `command` or no `id` are
 * dropped.
 */
export function buildServers(configList: unknown): ServerInfo[] {
  const list: readonly (Partial<LspServerEntry> | null | undefined)[] = Array.isArray(configList)
    ? configList
    : []
  return list
    .filter(
      (cfg): cfg is LspServerEntry =>
        !!cfg && !!cfg.id && typeof cfg.command === "string" && cfg.command.length > 0
    )
    .map((cfg) => ({
      id: cfg.id,
      extensions: (cfg.extensions ?? []).map((e) => String(e).toLowerCase()),
      filenames: cfg.filenames ?? [],
      root: rootResolverFor(cfg),
      resolveCommand: () => ({
        command: cfg.command,
        args: cfg.args ?? [],
        env: cfg.env,
        initializationOptions: cfg.initializationOptions,
      }),
      settings: cfg.settings,
      workspaceFolderRequired: cfg.workspaceFolderRequired,
      install: cfg.install,
      startupTimeout: cfg.startupTimeout,
    }))
}

/**
 * Candidate servers for a file, by extension (or exact filename). An
 * extension may match several servers (the resolver then filters by root
 * resolution).
 */
export function serversForFile(
  filePath: string,
  servers: readonly ServerInfo[] | null | undefined
): ServerInfo[] {
  const list = Array.isArray(servers) ? servers : []
  const ext = path.extname(filePath).toLowerCase()
  const base = path.basename(filePath)
  return list.filter(
    (s) =>
      (ext && s.extensions.includes(ext)) ||
      (Array.isArray(s.filenames) && s.filenames.includes(base))
  )
}

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

/**
 * Build a root resolver that walks up from a file's directory toward the
 * agent cwd (inclusive). Returns the first directory containing one of
 * `markers`. If a directory contains one of `excludeMarkers`, this server
 * is considered inapplicable for that tree and the resolver returns
 * `undefined` (a higher-priority toolchain owns it).
 *
 * @param {string[]} markers
 * @param {{ excludeMarkers?: string[] }} [opts]
 * @returns {(filePath: string, ctx?: { cwd?: string }) => string | undefined}
 */
export function nearestRoot(markers, opts = {}) {
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

function existsIn(dir, marker) {
  try {
    return fs.existsSync(path.join(dir, marker))
  } catch {
    return false
  }
}

/** True when `ancestor` is `dir` or a parent directory of `dir`. */
function isAncestor(ancestor, dir) {
  const a = path.resolve(ancestor)
  const d = path.resolve(dir)
  if (a === d) return true
  const rel = path.relative(a, d)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

/**
 * @typedef {Object} ServerInfo
 * @property {string} id
 * @property {string[]} extensions  lower-cased, with leading dot
 * @property {string[]} filenames
 * @property {(filePath: string, ctx?: { cwd?: string }) => string | undefined} root
 * @property {(root: string, ctx?: { cwd?: string }) => { command: string, args?: string[], env?: Record<string,string>, initializationOptions?: unknown }} resolveCommand
 * @property {Record<string, unknown>=} settings
 * @property {boolean=} workspaceFolderRequired
 * @property {{ npmPackage: string, version?: string }=} install  npm-provisioning metadata for the install ladder
 * @property {number=} startupTimeout  ms to wait for `initialize` before treating the spawn as failed
 */

/**
 * Root resolver for a config entry. With `rootMarkers`, walks up looking for
 * them (honouring `excludeRootMarkers`). Without markers, the server is
 * workspace-agnostic, so it anchors at the agent cwd (falling back to the
 * file's own directory when no cwd is supplied).
 *
 * @param {object} cfg
 * @returns {(filePath: string, ctx?: { cwd?: string }) => string | undefined}
 */
function rootResolverFor(cfg) {
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
 *
 * @param {Array<object>} configList
 * @returns {ServerInfo[]}
 */
export function buildServers(configList) {
  const list = Array.isArray(configList) ? configList : []
  return list
    .filter((cfg) => cfg && cfg.id && typeof cfg.command === "string" && cfg.command.length > 0)
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
 *
 * @param {string} filePath
 * @param {ServerInfo[]} servers  the built server list
 * @returns {ServerInfo[]}
 */
export function serversForFile(filePath, servers) {
  const list = Array.isArray(servers) ? servers : []
  const ext = path.extname(filePath).toLowerCase()
  const base = path.basename(filePath)
  return list.filter(
    (s) =>
      (ext && s.extensions.includes(ext)) ||
      (Array.isArray(s.filenames) && s.filenames.includes(base))
  )
}

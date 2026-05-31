// Agent-side LSP server registry.
//
// One `ServerInfo` per language, plus the `nearestRoot` combinator that
// walks up from a file to the agent cwd looking for project-root markers.
// This is the ONLY genuinely new piece of the agent LSP runtime — the
// actual client/lifecycle/dispatch is reused from the vscode-ext-host
// `LspService` (see `service-loader.mjs` + `resolver.mjs`).
//
// Inspired by OpenCode's `packages/opencode/src/lsp/server.ts`:
//   - extension-match selects candidate servers,
//   - `nearestRoot(markers, { excludeMarkers })` resolves the workspace
//     root, where an exclude marker closer to the file disables this
//     server for that tree (e.g. `deno.json` disables tsserver so the
//     Deno toolchain wins).

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
 * Static server registry. `resolveCommand` returns the spawn descriptor;
 * the binary is ensured (PATH probe / install ladder) by the resolver
 * before spawning, so a missing binary degrades to "server absent"
 * rather than a crash.
 *
 * @typedef {Object} ServerInfo
 * @property {string} id
 * @property {string[]} extensions
 * @property {(filePath: string, ctx?: { cwd?: string }) => string | undefined} root
 * @property {(root: string, ctx?: { cwd?: string }) => { command: string, args?: string[], env?: Record<string,string>, initializationOptions?: unknown }} resolveCommand
 */

/** @type {ServerInfo[]} */
export const SERVERS = [
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    root: nearestRoot(["tsconfig.json", "jsconfig.json", "package.json"], {
      excludeMarkers: ["deno.json", "deno.jsonc"],
    }),
    resolveCommand: () => ({
      command: "typescript-language-server",
      args: ["--stdio"],
    }),
  },
  {
    id: "pyright",
    extensions: [".py", ".pyi"],
    root: nearestRoot(["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"]),
    resolveCommand: () => ({
      command: "pyright-langserver",
      args: ["--stdio"],
    }),
  },
  {
    id: "rust-analyzer",
    extensions: [".rs"],
    // rust-analyzer prefers the workspace Cargo.toml — walk to the
    // outermost one within cwd by letting nearestRoot find the first,
    // then the resolver passes the dir as the workspace root.
    root: nearestRoot(["Cargo.toml"]),
    resolveCommand: () => ({ command: "rust-analyzer", args: [] }),
  },
  {
    id: "gopls",
    extensions: [".go"],
    root: nearestRoot(["go.work", "go.mod"]),
    resolveCommand: () => ({ command: "gopls", args: [] }),
  },
]

/**
 * Candidate servers for a file, by extension. An extension may match
 * several servers (the resolver then filters by root resolution).
 *
 * @param {string} filePath
 * @returns {ServerInfo[]}
 */
export function serversForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (!ext) return []
  return SERVERS.filter((s) => s.extensions.includes(ext))
}

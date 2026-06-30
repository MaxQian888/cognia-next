/**
 * Lightweight module-level import graph for wiki repo-map PageRank.
 *
 * The heavyweight tree-sitter code graph lives in the sidecar; the wiki
 * orchestrator runs in the renderer and can't reach it, so this derives a
 * coarse `importer → imported` module graph from data already in hand
 * (`CodeChunk.content`). It only needs module-to-module edges to rank modules,
 * not full symbol resolution — a deliberately simpler scanner, documented as
 * such. Edges are only created to modules that actually exist in the chunk set,
 * so external packages and unresolved specifiers drop out cleanly.
 *
 * Browser-safe: no node:path (the wiki indexer ships in the static export).
 */

import type { CodeChunk } from "../types"
import { moduleForPath, normalizePath } from "../file-walker"

/**
 * Build a directed module graph: `graph.get(M)` is the set of modules that
 * module `M` imports from. Self-edges and edges to unknown modules are dropped.
 */
export function buildImportGraph(chunks: readonly CodeChunk[]): Map<string, Set<string>> {
  const knownModules = new Set<string>()
  for (const chunk of chunks) knownModules.add(chunk.module)

  const graph = new Map<string, Set<string>>()
  for (const chunk of chunks) {
    const from = chunk.module
    for (const spec of extractImportSpecifiers(chunk.content, chunk.filePath)) {
      const target = resolveSpecifierToModule(spec, chunk.filePath, knownModules)
      if (target && target !== from && knownModules.has(target)) {
        let set = graph.get(from)
        if (!set) {
          set = new Set()
          graph.set(from, set)
        }
        set.add(target)
      }
    }
  }
  return graph
}

const TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i
const PY_EXT = /\.(py|pyi)$/i
const RS_EXT = /\.rs$/i

/** Extract raw import specifier strings from a chunk's source by language. */
export function extractImportSpecifiers(content: string, filePath: string): string[] {
  if (typeof content !== "string" || content.length === 0) return []
  if (TS_EXT.test(filePath)) return extractJsSpecifiers(content)
  if (PY_EXT.test(filePath)) return extractPySpecifiers(content)
  if (RS_EXT.test(filePath)) return extractRustSpecifiers(content)
  return []
}

function extractJsSpecifiers(content: string): string[] {
  const out: string[] = []
  const patterns = [
    /(?:import|export)[^;\n]*?from\s*['"]([^'"]+)['"]/g, // import … from "x" / export … from "x"
    /import\s*['"]([^'"]+)['"]/g, // bare `import "x"`
    /require\(\s*['"]([^'"]+)['"]\s*\)/g, // require("x")
    /import\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import("x")
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) out.push(m[1])
  }
  return out
}

function extractPySpecifiers(content: string): string[] {
  const out: string[] = []
  const re = /^\s*(?:from\s+([.\w]+)\s+import\b|import\s+([.\w]+))/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) out.push(m[1] ?? m[2])
  return out
}

function extractRustSpecifiers(content: string): string[] {
  const out: string[] = []
  const re = /^\s*use\s+([\w:]+)/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) out.push(m[1])
  return out
}

/**
 * Resolve an import specifier to a target module (directory), or null. Handles
 * JS/TS relative + `@/` alias, Python dotted, and Rust path specifiers,
 * matching only against the known-module set.
 */
export function resolveSpecifierToModule(
  spec: string,
  fromFilePath: string,
  knownModules: ReadonlySet<string>
): string | null {
  if (!spec) return null

  // JS/TS relative import → resolve against the importing file's directory.
  if (spec.startsWith(".")) {
    const baseDir = moduleForPath(fromFilePath)
    const resolvedFile = joinPosix(baseDir, spec)
    return moduleOf(resolvedFile, knownModules)
  }

  // `@/x/y` alias → repo-root-relative path.
  if (spec.startsWith("@/")) {
    return moduleOf(spec.slice(2), knownModules)
  }

  // Python dotted module (`a.b.c`) → path `a/b/c`.
  if (/^[\w.]+$/.test(spec) && spec.includes(".") && !spec.includes("/")) {
    const asPath = spec.replace(/\./g, "/")
    return moduleOf(asPath, knownModules)
  }

  // Rust path (`crate::a::b`) → strip crate/self/super, join with `/`.
  if (spec.includes("::")) {
    const parts = spec
      .split("::")
      .filter((p) => p && p !== "crate" && p !== "self" && p !== "super")
    if (parts.length === 0) return null
    return moduleOf(parts.join("/"), knownModules)
  }

  return null // bare package / unresolvable
}

/**
 * Map a resolved file-ish path to the nearest known module: the path's own
 * directory, then the path itself (for directory specifiers like `@/lib/x`).
 */
function moduleOf(resolvedPath: string, knownModules: ReadonlySet<string>): string | null {
  const norm = normalizePath(resolvedPath)
  const dir = parentDir(norm)
  if (dir && knownModules.has(dir)) return dir
  if (knownModules.has(norm)) return norm
  return null
}

/** POSIX join + normalize (resolve `.`/`..`), browser-safe. */
function joinPosix(base: string, rel: string): string {
  const baseSegs = normalizePath(base).split("/").filter(Boolean)
  const relSegs = normalizePath(rel).split("/")
  const stack = [...baseSegs]
  for (const seg of relSegs) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") stack.pop()
    else stack.push(seg)
  }
  return stack.join("/")
}

function parentDir(path: string): string {
  const segs = path.split("/").filter(Boolean)
  if (segs.length <= 1) return ""
  return segs.slice(0, -1).join("/")
}

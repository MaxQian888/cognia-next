// Lazy tree-sitter parser host for the code-graph subsystem.
//
// Uses `web-tree-sitter` (wasm) so there is no per-platform native compile.
// The runtime (`tree-sitter.wasm`) ships inside the `web-tree-sitter` package
// (a Tauri resource via `node_modules/**`); the per-grammar `.wasm` files are
// resolved by `resolveGrammarWasm` from one of several locations so the same
// code works in dev (node_modules), packaged Tauri (copied into `grammars/`),
// and the CLI bundle.
//
// Everything is lazy: `Parser.init()` and each grammar load happen on first use,
// and a missing runtime/grammar surfaces as a structured Error (the caller
// degrades that language rather than crashing the session).

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { GRAMMAR_KEYS } from "./languages/index.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))

let webTreeSitter = null
let initPromise = null
/** @type {Map<string, Promise<any>>} grammar key → Language load promise */
const grammarCache = new Map()
/** @type {Map<string, any>} grammar key → Parser instance */
const parserCache = new Map()

/**
 * Candidate directories that may hold the grammar `.wasm` files, most-specific
 * first. Exported (as a factory) so tests can assert each branch.
 * @param {string} [baseDir]
 * @returns {string[]}
 */
export function grammarSearchDirs(baseDir = HERE) {
  return [
    // (a) Copied alongside the sidecar source (packaged Tauri resource / CLI).
    path.join(baseDir, "grammars"),
    // (b) Tauri resource layout: <resources>/sidecar/builtin-tools/code/grammars
    //     resolved relative to the bundle root two levels up.
    path.join(baseDir, "..", "..", "code", "grammars"),
    // (c) Dev: the prebuilt wasms shipped by tree-sitter-wasms.
    nodeModulesGrammarDir(baseDir),
  ].filter(Boolean)
}

/** Locate `node_modules/tree-sitter-wasms/out` by walking up from `baseDir`. */
function nodeModulesGrammarDir(baseDir) {
  let dir = baseDir
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "node_modules", "tree-sitter-wasms", "out")
    if (safeIsDir(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Resolve the `.wasm` path for a grammar key, or throw a structured error.
 * @param {string} key  e.g. "typescript" | "tsx" | "rust" | "python"
 * @param {string} [baseDir]
 * @returns {string}
 */
export function resolveGrammarWasm(key, baseDir = HERE) {
  const file = `tree-sitter-${key}.wasm`
  for (const dir of grammarSearchDirs(baseDir)) {
    const full = path.join(dir, file)
    if (safeIsFile(full)) return full
  }
  throw new Error(
    `grammar wasm not found for "${key}" (looked for ${file} in: ${grammarSearchDirs(baseDir).join(", ")})`
  )
}

/** Initialise the web-tree-sitter runtime exactly once. */
async function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      const mod = await import("web-tree-sitter")
      webTreeSitter = mod
      await mod.Parser.init()
      return mod
    })().catch((err) => {
      initPromise = null // allow a later retry
      throw new Error(`web-tree-sitter runtime unavailable: ${err?.message ?? err}`)
    })
  }
  return initPromise
}

/** Load (and cache) the Language object for a grammar key. */
async function loadLanguage(key) {
  if (!grammarCache.has(key)) {
    grammarCache.set(
      key,
      (async () => {
        const mod = await ensureInit()
        const wasmPath = resolveGrammarWasm(key)
        const bytes = await fs.promises.readFile(wasmPath)
        return mod.Language.load(bytes)
      })().catch((err) => {
        grammarCache.delete(key)
        throw new Error(`failed to load grammar "${key}": ${err?.message ?? err}`)
      })
    )
  }
  return grammarCache.get(key)
}

/**
 * Get a parser bound to the given grammar key, parsing into a fresh tree.
 * Parsers are cached per grammar key (re-used across files); `parse` is
 * synchronous once the grammar is loaded.
 *
 * @param {string} grammarKey
 * @returns {Promise<{ parse: (source: string) => any, grammarKey: string }>}
 */
export async function getParser(grammarKey) {
  if (!GRAMMAR_KEYS.includes(grammarKey)) {
    throw new Error(`unknown grammar key: ${grammarKey}`)
  }
  let parser = parserCache.get(grammarKey)
  if (!parser) {
    const mod = await ensureInit()
    const language = await loadLanguage(grammarKey)
    parser = new mod.Parser()
    parser.setLanguage(language)
    parserCache.set(grammarKey, parser)
  }
  return {
    grammarKey,
    parse(source) {
      const tree = parser.parse(typeof source === "string" ? source : String(source ?? ""))
      if (!tree) throw new Error(`parse produced no tree for grammar "${grammarKey}"`)
      return tree
    },
  }
}

/** Drop all cached parsers/grammars (used at session teardown + in tests). */
export function resetParsers() {
  for (const p of parserCache.values()) {
    try {
      p.delete?.()
    } catch {
      /* ignore */
    }
  }
  parserCache.clear()
  grammarCache.clear()
}

function safeIsDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}
function safeIsFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

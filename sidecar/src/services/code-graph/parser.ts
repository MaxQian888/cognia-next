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

import type { Language, Parser } from "web-tree-sitter"

import { GRAMMAR_KEYS, type TreeNode } from "./languages/index.ts"

const HERE = path.dirname(fileURLToPath(import.meta.url))

type WebTreeSitter = typeof import("web-tree-sitter")

/** A parsed file: its root node plus the wasm tree's release hook. */
export interface ParsedTree {
  rootNode: TreeNode
  delete?(): void
}

/** A parser bound to one grammar; `parse` is synchronous once it is loaded. */
export interface CodeParser {
  grammarKey: string
  parse(source: unknown): ParsedTree
}

/** Where web-tree-sitter looks for its own `tree-sitter.wasm` runtime. */
export interface TreeSitterInitOptions {
  locateFile(file: string): string
}

/** The inputs `standaloneResourceDir` reads, injectable for tests. */
export interface StandaloneRuntime {
  bunStandalone: boolean
  execPath: string
}

let initPromise: Promise<WebTreeSitter> | null = null
/** grammar key → Language load promise */
const grammarCache = new Map<string, Promise<Language>>()
/** grammar key → Parser instance */
const parserCache = new Map<string, Parser>()

/**
 * Candidate directories that may hold the grammar `.wasm` files, most-specific
 * first. Exported (as a factory) so tests can assert each branch.
 */
export function grammarSearchDirs(
  baseDir: string = HERE,
  resourceDir: string | null = standaloneResourceDir()
): string[] {
  return [
    // Bun standalone resources live beside process.execPath; import.meta.url
    // points into /$bunfs and cannot reach files copied by the package builder.
    resourceDir ? path.join(resourceDir, "grammars") : null,
    // (a) Copied alongside the sidecar source (packaged Tauri resource / CLI).
    path.join(baseDir, "grammars"),
    // (b) Tauri resource layout: <resources>/sidecar/builtin-tools/code/grammars
    //     resolved relative to the bundle root two levels up.
    path.join(baseDir, "..", "..", "code", "grammars"),
    // (c) Dev: the prebuilt wasms shipped by tree-sitter-wasms.
    nodeModulesGrammarDir(baseDir),
  ].filter((dir): dir is string => dir !== null)
}

/** Physical resource directory for a Bun standalone executable, if any. */
export function standaloneResourceDir(
  runtime: StandaloneRuntime = {
    bunStandalone: Boolean(
      (globalThis as { Bun?: { isStandaloneExecutable?: boolean } }).Bun?.isStandaloneExecutable
    ),
    execPath: process.execPath,
  }
): string | null {
  return runtime.bunStandalone ? path.dirname(runtime.execPath) : null
}

/** web-tree-sitter init options that redirect its runtime out of /$bunfs. */
export function treeSitterInitOptions(
  resourceDir: string | null = standaloneResourceDir()
): TreeSitterInitOptions | undefined {
  if (!resourceDir) return undefined
  return {
    locateFile: () => path.join(resourceDir, "tree-sitter.wasm"),
  }
}

/** Locate `node_modules/tree-sitter-wasms/out` by walking up from `baseDir`. */
function nodeModulesGrammarDir(baseDir: string): string | null {
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
 * Resolve the `.wasm` path for a grammar key (e.g. "typescript", "tsx",
 * "rust", "python"), or throw a structured error.
 */
export function resolveGrammarWasm(key: string, baseDir: string = HERE): string {
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
async function ensureInit(): Promise<WebTreeSitter> {
  if (!initPromise) {
    initPromise = (async () => {
      const mod = await import("web-tree-sitter")
      // The typings name the option bag `EmscriptenModule` without declaring
      // it; `locateFile` is the one field web-tree-sitter documents for it.
      await mod.Parser.init(treeSitterInitOptions() as Parameters<typeof mod.Parser.init>[0])
      return mod
    })().catch((err: unknown) => {
      initPromise = null // allow a later retry
      throw new Error(
        `web-tree-sitter runtime unavailable: ${(err as Error | null)?.message ?? err}`
      )
    })
  }
  return initPromise
}

/** Load (and cache) the Language object for a grammar key. */
async function loadLanguage(key: string): Promise<Language> {
  let pending = grammarCache.get(key)
  if (!pending) {
    pending = (async () => {
      const mod = await ensureInit()
      const wasmPath = resolveGrammarWasm(key)
      const bytes = await fs.promises.readFile(wasmPath)
      return mod.Language.load(bytes)
    })().catch((err: unknown) => {
      grammarCache.delete(key)
      throw new Error(`failed to load grammar "${key}": ${(err as Error | null)?.message ?? err}`)
    })
    grammarCache.set(key, pending)
  }
  return pending
}

/**
 * Get a parser bound to the given grammar key, parsing into a fresh tree.
 * Parsers are cached per grammar key (re-used across files); `parse` is
 * synchronous once the grammar is loaded.
 */
export async function getParser(grammarKey: string): Promise<CodeParser> {
  if (!GRAMMAR_KEYS.includes(grammarKey)) {
    throw new Error(`unknown grammar key: ${grammarKey}`)
  }
  let cached = parserCache.get(grammarKey)
  if (!cached) {
    const mod = await ensureInit()
    const language = await loadLanguage(grammarKey)
    cached = new mod.Parser()
    cached.setLanguage(language)
    parserCache.set(grammarKey, cached)
  }
  const parser = cached
  return {
    grammarKey,
    parse(source) {
      const tree = parser.parse(typeof source === "string" ? source : String(source ?? ""))
      if (!tree) throw new Error(`parse produced no tree for grammar "${grammarKey}"`)
      // web-tree-sitter types its child lists `(Node | null)[]`, but a parsed
      // tree's `children` / `namedChildren` never hold null, so its nodes
      // satisfy the narrower `TreeNode` surface the extractor reads.
      return tree as unknown as ParsedTree
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

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}
function safeIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

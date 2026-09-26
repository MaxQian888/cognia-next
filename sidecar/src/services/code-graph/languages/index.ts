// Language registry for the code-graph subsystem.
//
// Maps file extensions to a language id, exposes the supported-language set,
// and routes a language id to its tree-sitter query bundle. The extension →
// language idea mirrors `serversForFile` in `src/services/lsp/servers.ts` (we reuse
// the *idea*, not the LSP server list — code-graph supports a fixed set of
// grammars, not arbitrary user-configured servers).
//
// A grammar is loaded lazily by `../parser.ts` only for languages that
// actually appear in the indexed tree; `grammarAssets()` names the `.wasm`
// files shipped under `../grammars/`.

import path from "node:path"

import * as typescript from "./typescript.ts"
import * as javascript from "./javascript.ts"
import * as rust from "./rust.ts"
import * as python from "./python.ts"

export type LanguageId = "typescript" | "javascript" | "rust" | "python"

export interface TreePoint {
  row: number
  column: number
}

/**
 * The tree-sitter node surface the descriptors and the extractor read: a
 * web-tree-sitter `Node`, or a test fake that implements only what it needs.
 */
export interface TreeNode {
  type: string
  text: string
  startIndex: number
  endIndex: number
  startPosition: TreePoint
  endPosition: TreePoint
  parent: TreeNode | null
  previousNamedSibling?: TreeNode | null
  children?: readonly TreeNode[]
  namedChildren: readonly TreeNode[]
  childForFieldName?(name: string): TreeNode | null
}

/** Modifiers and signature bits a descriptor reads off a symbol node. */
export interface SymbolModifiers {
  isExported?: boolean
  isAsync?: boolean
  isStatic?: boolean
  isAbstract?: boolean
  visibility?: string | null
  returnType?: string | null
  signature?: string | null
}

/** How one language's AST becomes graph nodes, edges and references. */
export interface LanguageDescriptor {
  grammarKeys: readonly string[]
  /** AST node type → graph symbol kind. */
  SYMBOL_TYPES: Readonly<Record<string, string>>
  /** Call-site node types → an unresolved `calls` edge. */
  CALL_TYPES: ReadonlySet<string>
  /** Import node types → an unresolved `imports` edge. */
  IMPORT_TYPES: ReadonlySet<string>
  nodeName(node: TreeNode): string | null
  refineKind?(node: TreeNode, baseKind: string): string
  shouldSkip?(node: TreeNode): boolean
  calleeName(callNode: TreeNode): string | null
  importSource(node: TreeNode): string | null
  baseNames?(node: TreeNode): string[]
  modifiers(node: TreeNode, source: string): SymbolModifiers
  buildSignature(node: TreeNode, source: string): string
  /** Rust `impl Trait for Type` pairs (type → trait). */
  implEdges?(root: TreeNode): { from: string; to: string }[]
}

/** The descriptors keyed by language id. */
export const LANGUAGE_BUNDLES: Readonly<Record<LanguageId, LanguageDescriptor>> = Object.freeze({
  typescript,
  javascript,
  rust,
  python,
})

export const SUPPORTED_LANGUAGES: readonly LanguageId[] = Object.freeze(
  Object.keys(LANGUAGE_BUNDLES) as LanguageId[]
)

/**
 * Extension (lower-case, with leading dot) → language id. TSX/JSX share the
 * typescript/javascript *query bundles* (JSX is a superset for symbol/import
 * extraction purposes), but use a distinct tree-sitter *grammar* — see
 * `EXT_TO_GRAMMAR`. `.mjs`/`.cjs` are JavaScript; `.mts`/`.cts` are TypeScript.
 */
export const EXT_TO_LANGUAGE: Readonly<Record<string, LanguageId>> = Object.freeze({
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".rs": "rust",
  ".py": "python",
  ".pyi": "python",
})

/**
 * Extension → tree-sitter grammar key. The grammar key names the `.wasm` file
 * (`tree-sitter-<key>.wasm`). `tsx` and `typescript` are genuinely distinct
 * tree-sitter grammars (the `tsx` grammar parses JSX; the `typescript` grammar
 * parses `<T>` type-assertion syntax that conflicts with JSX), so `.tsx`/`.jsx`
 * route to `tsx` while `.ts`/`.mts`/`.cts` route to `typescript`. JavaScript
 * (`.js`/`.mjs`/`.cjs`) uses the `tsx` grammar too — it is a superset that
 * parses plain JS and JSX, sparing a separate javascript grammar.
 */
export const EXT_TO_GRAMMAR: Readonly<Record<string, string>> = Object.freeze({
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "tsx",
  ".jsx": "tsx",
  ".mjs": "tsx",
  ".cjs": "tsx",
  ".rs": "rust",
  ".py": "python",
  ".pyi": "python",
})

/**
 * Resolve a file path to a supported language id, or `null` when the extension
 * is not one we extract.
 */
export function languageFor(filePath: unknown): LanguageId | null {
  if (typeof filePath !== "string" || filePath.length === 0) return null
  const ext = path.extname(filePath).toLowerCase()
  return EXT_TO_LANGUAGE[ext] ?? null
}

/** True when the path is a source file we know how to extract. */
export function isSupportedFile(filePath: unknown): boolean {
  return languageFor(filePath) !== null
}

/**
 * Resolve a file path to its tree-sitter grammar key (the `.wasm` basename
 * without the `tree-sitter-` prefix), or `null` when unsupported.
 */
export function grammarKeyFor(filePath: unknown): string | null {
  if (typeof filePath !== "string" || filePath.length === 0) return null
  const ext = path.extname(filePath).toLowerCase()
  return EXT_TO_GRAMMAR[ext] ?? null
}

/** The distinct grammar keys we may load. */
export const GRAMMAR_KEYS: readonly string[] = Object.freeze([
  ...new Set(Object.values(EXT_TO_GRAMMAR)),
])

/** Return the descriptor for a language id. */
export function queriesFor(lang: string): LanguageDescriptor {
  const bundle = (LANGUAGE_BUNDLES as Readonly<Record<string, LanguageDescriptor | undefined>>)[
    lang
  ]
  if (!bundle) throw new Error(`unsupported language: ${lang}`)
  return bundle
}

/**
 * The set of distinct grammar `.wasm` filenames we may load — one per grammar
 * key. Used by the build copy-step (`copy-codegraph-grammars.mjs`) and the
 * parser's grammar locator.
 */
export function grammarAssets(): string[] {
  return GRAMMAR_KEYS.map((key) => `tree-sitter-${key}.wasm`)
}

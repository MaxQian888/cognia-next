// Language registry for the code-graph subsystem.
//
// Maps file extensions to a language id, exposes the supported-language set,
// and routes a language id to its tree-sitter query bundle. The extension →
// language idea mirrors `serversForFile` in `sidecar/lsp/servers.mjs` (we reuse
// the *idea*, not the LSP server list — code-graph supports a fixed set of
// grammars, not arbitrary user-configured servers).
//
// A grammar is loaded lazily by `parser.mjs` only for languages that actually
// appear in the indexed tree; the `grammarAsset` in each language bundle names
// the `.wasm` file shipped under `code/grammars/`.

import path from "node:path"

import * as typescript from "./typescript.mjs"
import * as javascript from "./javascript.mjs"
import * as rust from "./rust.mjs"
import * as python from "./python.mjs"

/** @typedef {"typescript" | "javascript" | "rust" | "python"} LanguageId */

/**
 * The query bundles keyed by language id. Each bundle exports
 * `{ grammarAsset, nodeQuery, importQuery }` plus optional helpers.
 * @type {Record<LanguageId, typeof typescript>}
 */
export const LANGUAGE_BUNDLES = Object.freeze({
  typescript,
  javascript,
  rust,
  python,
})

/** @type {readonly LanguageId[]} */
export const SUPPORTED_LANGUAGES = Object.freeze(
  /** @type {LanguageId[]} */ (Object.keys(LANGUAGE_BUNDLES))
)

/**
 * Extension (lower-case, with leading dot) → language id. TSX/JSX share the
 * typescript/javascript *query bundles* (JSX is a superset for symbol/import
 * extraction purposes), but use a distinct tree-sitter *grammar* — see
 * `EXT_TO_GRAMMAR`. `.mjs`/`.cjs` are JavaScript; `.mts`/`.cts` are TypeScript.
 * @type {Readonly<Record<string, LanguageId>>}
 */
export const EXT_TO_LANGUAGE = Object.freeze({
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
 * @type {Readonly<Record<string, string>>}
 */
export const EXT_TO_GRAMMAR = Object.freeze({
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
 * @param {string} filePath
 * @returns {LanguageId | null}
 */
export function languageFor(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return null
  const ext = path.extname(filePath).toLowerCase()
  return EXT_TO_LANGUAGE[ext] ?? null
}

/** True when the path is a source file we know how to extract. */
export function isSupportedFile(filePath) {
  return languageFor(filePath) !== null
}

/**
 * Resolve a file path to its tree-sitter grammar key (the `.wasm` basename
 * without the `tree-sitter-` prefix), or `null` when unsupported.
 * @param {string} filePath
 * @returns {string | null}
 */
export function grammarKeyFor(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return null
  const ext = path.extname(filePath).toLowerCase()
  return EXT_TO_GRAMMAR[ext] ?? null
}

/** The distinct grammar keys we may load. */
export const GRAMMAR_KEYS = Object.freeze([...new Set(Object.values(EXT_TO_GRAMMAR))])

/**
 * Return the query bundle for a language id.
 * @param {LanguageId} lang
 * @returns {typeof typescript}
 */
export function queriesFor(lang) {
  const bundle = LANGUAGE_BUNDLES[lang]
  if (!bundle) throw new Error(`unsupported language: ${lang}`)
  return bundle
}

/**
 * The set of distinct grammar `.wasm` filenames we may load — one per grammar
 * key. Used by the build copy-step (`copy-codegraph-grammars.mjs`) and the
 * parser's grammar locator.
 * @returns {string[]}
 */
export function grammarAssets() {
  return GRAMMAR_KEYS.map((key) => `tree-sitter-${key}.wasm`)
}

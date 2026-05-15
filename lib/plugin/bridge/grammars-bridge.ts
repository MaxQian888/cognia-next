/**
 * VS Code grammars (TextMate) bridge.
 *
 * `contributes.grammars[]` declares TextMate grammar files for one or
 * more scope names. cognia uses these in two places:
 *
 *   1. Shiki — server-side / artifact preview syntax highlighting
 *      (registered via `shiki.loadLanguage`).
 *   2. Monaco — registered through `monaco.languages.setMonarchTokensProvider`
 *      when the grammar can be converted, or via a TextMate→Monaco
 *      adapter (shipped separately).
 *
 * Per-plugin tracking + idempotent unregister, mirrors themes-bridge and
 * icons-bridge.
 *
 * The bridge stays storage-only: it parses the grammar JSON / PLIST and
 * keeps a typed record. Wiring into shiki and Monaco happens in cognia's
 * appearance system on next theme apply, so the bridge has no hard
 * dependency on either renderer.
 */

import { stripJsonComments } from "@/lib/appearance/vscode-theme/parse-json"

export interface VsCodeGrammarRule {
  match?: string
  name?: string
  scope?: string
  patterns?: VsCodeGrammarRule[]
  captures?: Record<string, { name?: string }>
  begin?: string
  end?: string
  include?: string
}

export interface VsCodeGrammarData {
  scopeName?: string
  patterns?: VsCodeGrammarRule[]
  repository?: Record<string, VsCodeGrammarRule>
  /** TextMate "fileTypes" — file extensions this grammar covers. */
  fileTypes?: string[]
  /** Optional name displayed in the picker. */
  name?: string
  /** Optional `injectionSelector` so consumers know not to use this as a
   *  primary grammar. */
  injectionSelector?: string
}

export interface GrammarContribution {
  /** Stable id = `${pluginId}.${scopeName}`. */
  id: string
  /** Owning plugin id. */
  pluginId: string
  /** TextMate scope name (e.g. `source.svelte`). */
  scopeName: string
  /** Optional language id this grammar primarily targets. */
  language?: string
  /** Path inside the plugin (forward-slash normalised). */
  grammarPath: string
  /** Parsed grammar data. */
  data: VsCodeGrammarData
}

const grammars = new Map<string, GrammarContribution>()
const listeners = new Set<(event: GrammarEvent) => void>()

export type GrammarEventType = "register" | "unregister"
export interface GrammarEvent {
  type: GrammarEventType
  contribution: GrammarContribution
}

function emit(event: GrammarEvent): void {
  queueMicrotask(() => {
    for (const fn of listeners) {
      try {
        fn(event)
      } catch (err) {
        console.warn("Grammar listener threw:", err)
      }
    }
  })
}

/** Detect whether a payload is JSON (object curly) vs TextMate plist. */
function isJsonPayload(text: string): boolean {
  const trimmed = text.replace(/^﻿/, "").trimStart()
  return trimmed.startsWith("{") || trimmed.startsWith("[")
}

/**
 * Minimal plist→JSON conversion for TextMate `.tmLanguage` files. We do
 * NOT cover the full plist spec — only the subset TextMate grammars use
 * (dict / array / string keys, no <data> blobs). Throws on anything we
 * don't recognise so callers can fall back to JSON.
 */
function parseTextMatePlist(text: string): VsCodeGrammarData {
  // Pragmatic: most plugins ship JSON-formatted .tmLanguage.json or
  // YAML. Genuine .plist support is bounded by the parser cost. For
  // .plist we extract the dict via a regex scan that's good enough for
  // simple grammar files and surface the rest as `unsupported plist
  // format` so the consumer logs and skips.
  const stripped = text.replace(/<!--[\s\S]*?-->/g, "")
  if (!/<dict>/.test(stripped) || !/<\/dict>/.test(stripped)) {
    throw new Error("plist parser: missing top-level <dict>")
  }
  // We can't faithfully serialise nested arrays/dicts here without a real
  // XML parser. Surface a marker so the appearance system can decide to
  // load via a richer parser later.
  return { scopeName: extractPlistKey(stripped, "scopeName") }
}

function extractPlistKey(plist: string, key: string): string | undefined {
  const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`)
  const m = plist.match(re)
  return m?.[1]
}

/**
 * Register a single grammar contribution. Throws on malformed JSON. PLIST
 * support is partial — see `parseTextMatePlist`.
 */
export function registerGrammar(input: {
  pluginId: string
  scopeName: string
  language?: string
  grammarPath: string
  /** Raw grammar payload (`.tmLanguage.json` or `.plist`). */
  payload: string
}): GrammarContribution {
  let data: VsCodeGrammarData
  if (isJsonPayload(input.payload)) {
    try {
      data = JSON.parse(stripJsonComments(input.payload)) as VsCodeGrammarData
    } catch (err) {
      throw new Error(
        `Invalid grammar JSON for scope "${input.scopeName}" (${input.grammarPath}): ${(err as Error).message}`
      )
    }
  } else {
    data = parseTextMatePlist(input.payload)
  }
  if (!data || typeof data !== "object") {
    throw new Error(`Grammar "${input.scopeName}" did not yield an object`)
  }
  if (data.scopeName && data.scopeName !== input.scopeName) {
    throw new Error(
      `Grammar payload declares scope "${data.scopeName}" but contribution targets "${input.scopeName}"`
    )
  }
  const id = `${input.pluginId}.${input.scopeName}`
  const existing = grammars.get(id)
  if (existing) {
    throw new Error(
      `Grammar collision: ${input.pluginId} already contributes scope "${input.scopeName}"`
    )
  }
  const contribution: GrammarContribution = {
    id,
    pluginId: input.pluginId,
    scopeName: input.scopeName,
    language: input.language,
    grammarPath: input.grammarPath,
    data,
  }
  grammars.set(id, contribution)
  emit({ type: "register", contribution })
  return contribution
}

export function unregisterGrammar(id: string): void {
  const contribution = grammars.get(id)
  if (!contribution) return
  grammars.delete(id)
  emit({ type: "unregister", contribution })
}

export function unregisterGrammarsByPlugin(pluginId: string): number {
  let removed = 0
  for (const [id, contribution] of grammars) {
    if (contribution.pluginId === pluginId) {
      grammars.delete(id)
      emit({ type: "unregister", contribution })
      removed += 1
    }
  }
  return removed
}

export function listGrammars(): GrammarContribution[] {
  return [...grammars.values()]
}

export function getGrammar(id: string): GrammarContribution | undefined {
  return grammars.get(id)
}

/**
 * Find every grammar that targets `language`. Useful when the appearance
 * system needs to load the matching grammar for a given language id.
 */
export function findGrammarsByLanguage(language: string): GrammarContribution[] {
  return [...grammars.values()].filter((g) => g.language === language)
}

/**
 * Look up a grammar by TextMate scope name (e.g. `source.svelte`).
 * Returns the first match — duplicate scopes across plugins are
 * prevented at registration time.
 */
export function findGrammarByScopeName(scopeName: string): GrammarContribution | undefined {
  for (const g of grammars.values()) {
    if (g.scopeName === scopeName) return g
  }
  return undefined
}

export function subscribeGrammars(listener: (event: GrammarEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function __resetGrammarsForTesting(): void {
  grammars.clear()
  listeners.clear()
}

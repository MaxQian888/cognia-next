/**
 * VS Code snippets bridge.
 *
 * `contributes.snippets[]` declares per-language snippet files that VS Code
 * surfaces via the editor's completion engine. cognia surfaces them in two
 * places:
 *
 *   1. Monaco completion suggestions (`monaco.languages.registerCompletionItemProvider`)
 *      — when a cognia editor surface (Skills/Canvas/Artifact) is open and
 *      the language matches.
 *   2. Slash-command palette — snippets prefixed with `!` become
 *      typeable in the chat composer.
 *
 * Snippet files use the VS Code snippet JSON format:
 *
 *   { "snippet-name": { "prefix": "for", "body": ["for (...) { $0 }"], "description": "..." } }
 *
 * The body may contain tab stops (`$1`, `$2`), choices (`${1|a,b,c|}`),
 * variables (`$TM_FILENAME`), and the final cursor stop (`$0`). We preserve
 * them verbatim — Monaco's snippet engine handles them natively.
 *
 * Per-plugin tracking + idempotent unregister, mirrors themes-bridge.
 */

import { stripJsonComments } from "@/lib/appearance/vscode-theme/parse-json"

export interface VsCodeSnippetBody {
  prefix: string | string[]
  body: string | string[]
  description?: string
  scope?: string
}

export interface SnippetContribution {
  /** Stable id = `${pluginId}:${language}:${name}`. */
  id: string
  /** Owning plugin id. */
  pluginId: string
  /** Language id the snippet applies to (e.g. `"typescript"`). */
  language: string
  /** Snippet name from the source JSON object key. */
  name: string
  /** Trigger prefix(es). VS Code allows arrays. */
  prefix: string[]
  /** Multi-line body joined with `\n`. */
  body: string
  /** Free-text description for completion details. */
  description?: string
}

const snippets = new Map<string, SnippetContribution>()
const listeners = new Set<(event: SnippetEvent) => void>()

export type SnippetEventType = "register" | "unregister"
export interface SnippetEvent {
  type: SnippetEventType
  contribution: SnippetContribution
}

function emit(event: SnippetEvent): void {
  queueMicrotask(() => {
    for (const fn of listeners) {
      try {
        fn(event)
      } catch (err) {
        console.warn("Snippet listener threw:", err)
      }
    }
  })
}

/**
 * Parse a VS Code snippet JSON file and register every snippet under the
 * supplied plugin id + language. Returns the registered contributions.
 *
 * Malformed entries are skipped with a warning — don't fail the whole
 * registration over one bad snippet.
 */
export function registerSnippetFile(
  pluginId: string,
  language: string,
  source: string
): SnippetContribution[] {
  let parsed: Record<string, VsCodeSnippetBody>
  try {
    parsed = JSON.parse(stripJsonComments(source)) as Record<string, VsCodeSnippetBody>
  } catch (err) {
    console.warn(
      `[snippets-bridge] plugin ${pluginId} ${language} snippet file failed to parse: ${(err as Error).message}`
    )
    return []
  }
  if (!parsed || typeof parsed !== "object") return []
  const out: SnippetContribution[] = []
  for (const [name, raw] of Object.entries(parsed)) {
    if (!raw || typeof raw !== "object") continue
    if (typeof raw.prefix !== "string" && !Array.isArray(raw.prefix)) continue
    if (typeof raw.body !== "string" && !Array.isArray(raw.body)) continue
    const prefix = Array.isArray(raw.prefix)
      ? raw.prefix.filter((p): p is string => typeof p === "string")
      : [raw.prefix]
    const body = Array.isArray(raw.body) ? raw.body.join("\n") : raw.body
    if (prefix.length === 0) continue
    const contribution: SnippetContribution = {
      id: `${pluginId}:${language}:${name}`,
      pluginId,
      language,
      name,
      prefix,
      body,
      description: typeof raw.description === "string" ? raw.description : undefined,
    }
    snippets.set(contribution.id, contribution)
    emit({ type: "register", contribution })
    out.push(contribution)
  }
  return out
}

export function unregisterSnippet(id: string): void {
  const contribution = snippets.get(id)
  if (!contribution) return
  snippets.delete(id)
  emit({ type: "unregister", contribution })
}

export function unregisterSnippetsByPlugin(pluginId: string): number {
  let removed = 0
  for (const [id, contribution] of snippets) {
    if (contribution.pluginId === pluginId) {
      snippets.delete(id)
      emit({ type: "unregister", contribution })
      removed += 1
    }
  }
  return removed
}

export function listSnippetsForLanguage(language: string): SnippetContribution[] {
  const out: SnippetContribution[] = []
  for (const c of snippets.values()) {
    if (c.language === language) out.push(c)
  }
  return out
}

export function listAllSnippets(): SnippetContribution[] {
  return [...snippets.values()]
}

export function subscribeSnippets(listener: (event: SnippetEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function __resetSnippetsForTesting(): void {
  snippets.clear()
  listeners.clear()
}

// ── W5.1: enable-time registration from manifest.vscodeSnippets ──────────────
import { isUnsafeRelativePath, readContainedPluginFile } from "./plugin-file-path"

export interface SnippetManifestEntry {
  language: string
  path: string
}

export async function registerSnippetsForPlugin(
  pluginId: string,
  entries: readonly SnippetManifestEntry[],
  baseDir: string
): Promise<{ registered: number; errors: string[] }> {
  const errors: string[] = []
  let registered = 0
  for (const entry of entries) {
    try {
      if (!entry.language) throw new Error("missing snippet language")
      if (isUnsafeRelativePath(entry.path)) {
        throw new Error(`unsafe snippet path "${entry.path}"`)
      }
      const source = await readContainedPluginFile(pluginId, baseDir, entry.path)
      registered += registerSnippetFile(pluginId, entry.language, source).length
    } catch (err) {
      errors.push(`${entry.language || entry.path}: ${(err as Error).message}`)
    }
  }
  return { registered, errors }
}

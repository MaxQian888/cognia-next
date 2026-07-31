/**
 * Monaco snippet + Emmet registration.
 *
 * Snippet items come from two live sources, read fresh on every completion
 * request so late-registered plugin snippets appear without re-registration:
 *   - the canvas snippet registry (`snippetProvider`, `@/lib/canvas/snippets`)
 *   - plugin-contributed snippets (`listSnippetsForLanguage`, the VS Code
 *     snippets bridge)
 *
 * Emmet expansion (html / css / jsx) is provided by `emmet-monaco-es`,
 * lazy-imported and desktop-only (it pulls the `emmet` engine — keep it off
 * the mobile/web bundle).
 *
 * Both registrations are GLOBAL per Monaco instance (completion providers are
 * registered against the `monaco.languages` namespace, not a single editor),
 * so they are guarded to run exactly once per instance even though every
 * editor mount calls them.
 */

import { snippetProvider } from "@/lib/canvas/snippets/snippet-registry"
import { listSnippetsForLanguage } from "@/lib/plugin/bridge/snippets-bridge"
import { isTauri } from "@/lib/tauri"
import { loggers } from "@cognia/logging"

const snippetsLogger = loggers.canvas.child("monaco-snippets")

export interface MonacoLikeRegistration {
  dispose(): void
}

// ────────────────────────────────────────────────────────────────────────
// Minimal Monaco shapes (decoupled from the monaco-editor package types so
// this module stays cheap to import and easy to test).
// ────────────────────────────────────────────────────────────────────────

interface MonacoModelLike {
  getLanguageId(): string
  getWordUntilPosition(position: MonacoPositionLike): {
    startColumn: number
    endColumn: number
  }
}

interface MonacoPositionLike {
  lineNumber: number
  column: number
}

interface CompletionProviderLike {
  provideCompletionItems(
    model: MonacoModelLike,
    position: MonacoPositionLike
  ): { suggestions: unknown[] }
}

interface MonacoLanguagesLike {
  registerCompletionItemProvider(
    languageSelector: string | string[],
    provider: CompletionProviderLike
  ): MonacoLikeRegistration
  CompletionItemKind: { Snippet: number }
  CompletionItemInsertTextRule: { InsertAsSnippet: number }
}

interface MonacoLike {
  languages: MonacoLanguagesLike
}

// Track instances we've already wired so repeated editor mounts don't stack
// duplicate providers on the same Monaco namespace.
const snippetsRegistered = new WeakSet<object>()
const emmetRegistered = new WeakSet<object>()

/** Join a snippet body (string | string[]) into a single insert string. */
function bodyToInsertText(body: string | string[]): string {
  return Array.isArray(body) ? body.join("\n") : body
}

export interface EditorSnippetCompletion {
  label: string
  insertText: string
  detail?: string
  documentation?: string
}

const SNIPPET_LANGUAGE_GROUPS = [
  ["typescript", "javascript", "typescriptreact", "javascriptreact"],
  ["shell", "shellscript", "bash", "sh"],
  ["json", "jsonc"],
] as const

function compatibleSnippetLanguageIds(language: string): readonly string[] {
  const normalized = language.toLowerCase()
  return (
    SNIPPET_LANGUAGE_GROUPS.find((group) => group.some((id) => id === normalized)) ?? [language]
  )
}

/**
 * Normalize builtin/user and plugin snippets into an editor-agnostic list.
 * Read registries on every request so late plugin activation is immediately
 * visible in both Monaco and the mobile CodeMirror editor.
 */
export function collectEditorSnippets(language: string): EditorSnippetCompletion[] {
  const out: EditorSnippetCompletion[] = []
  const seen = new Set<string>()
  const add = (snippet: EditorSnippetCompletion): void => {
    const key = `${snippet.label}\0${snippet.insertText}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(snippet)
  }

  for (const languageId of compatibleSnippetLanguageIds(language)) {
    for (const snippet of snippetProvider.getSnippets(languageId)) {
      add({
        label: snippet.prefix,
        insertText: bodyToInsertText(snippet.body),
        detail: snippet.description,
        documentation: snippet.category ? `${snippet.category} snippet` : undefined,
      })
    }
    for (const snippet of listSnippetsForLanguage(languageId)) {
      for (const prefix of snippet.prefix) {
        add({
          label: prefix,
          insertText: snippet.body,
          detail: snippet.description ?? `${snippet.pluginId} snippet`,
          documentation: `${snippet.pluginId} · ${snippet.name}`,
        })
      }
    }
  }
  return out
}

/**
 * Register a completion provider that surfaces canvas + plugin snippets for
 * the model's language. Idempotent per Monaco instance. Returns the
 * disposable(s) created on the first call (empty on subsequent calls).
 */
export function registerAllSnippets(monacoNs: unknown): MonacoLikeRegistration[] {
  const monaco = monacoNs as MonacoLike | null
  if (!monaco?.languages?.registerCompletionItemProvider) return []
  if (snippetsRegistered.has(monaco)) return []
  snippetsRegistered.add(monaco)

  const SnippetKind = monaco.languages.CompletionItemKind.Snippet
  const InsertAsSnippet = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet

  const provider: CompletionProviderLike = {
    provideCompletionItems(model, position) {
      const language = model.getLanguageId()
      const word = model.getWordUntilPosition(position)
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      }
      const suggestions: unknown[] = []

      for (const snippet of collectEditorSnippets(language)) {
        suggestions.push({
          label: snippet.label,
          kind: SnippetKind,
          insertText: snippet.insertText,
          insertTextRules: InsertAsSnippet,
          detail: snippet.detail,
          documentation: snippet.documentation,
          range,
        })
      }

      return { suggestions }
    },
  }

  // Monaco's wildcard selector includes languages registered after this call;
  // the provider still resolves snippets against the live model language.
  const disposable = monaco.languages.registerCompletionItemProvider("*", provider)
  return [disposable]
}

/**
 * Enable Emmet abbreviation expansion (html / css / jsx / tsx …). Desktop-only
 * and lazy — `emmet-monaco-es` pulls the `emmet` engine which must stay off
 * the mobile/web bundle. Idempotent per Monaco instance.
 *
 * Because the engine is dynamically imported, the real disposers attach
 * asynchronously; the returned registration disposes them once ready (and
 * flips a flag so a dispose that races the import still tears down).
 */
export function registerEmmetSupport(monacoNs: unknown): MonacoLikeRegistration[] {
  const monaco = monacoNs as object | null
  if (!monaco) return []
  if (!isTauri()) return []
  if (emmetRegistered.has(monaco)) return []
  emmetRegistered.add(monaco)

  let disposed = false
  const realDisposers: Array<() => void> = []

  void import("emmet-monaco-es")
    .then(({ emmetHTML, emmetCSS, emmetJSX }) => {
      if (disposed) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- emmet types want the full monaco-editor typeof; our namespace is compatible at runtime.
      const m = monaco as any
      realDisposers.push(
        emmetHTML(m, ["html", "php", "handlebars", "twig", "markdown"]),
        emmetCSS(m, ["css", "scss", "less", "sass"]),
        emmetJSX(m, ["javascript", "javascriptreact", "typescript", "typescriptreact"])
      )
    })
    .catch((err) => {
      emmetRegistered.delete(monaco)
      snippetsLogger.warn("emmet registration failed", { err: String(err) })
    })

  return [
    {
      dispose() {
        disposed = true
        for (const d of realDisposers) {
          try {
            d()
          } catch {
            /* swallow */
          }
        }
        realDisposers.length = 0
        emmetRegistered.delete(monaco)
      },
    },
  ]
}

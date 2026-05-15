/**
 * VS Code language contributions bridge.
 *
 * `contributes.languages[]` declares language ids cognia should recognise
 * (file extensions, aliases, configuration files). cognia uses these in
 * two places:
 *
 *   1. The plugin language registry — extends cognia's mime / language
 *      detection so an artifact named `Foo.svelte` is treated as Svelte.
 *   2. Monaco — `monaco.languages.register({ id, extensions, aliases })`
 *      and `monaco.languages.setLanguageConfiguration(id, configuration)`
 *      so completion / hover / formatting providers can bind to the new
 *      language id.
 *
 * The bridge is storage-only; cognia's appearance / Monaco bootstrap
 * reads the registered list on next theme apply.
 */

import { stripJsonComments } from "@/lib/appearance/vscode-theme/parse-json"

export interface VsCodeLanguageContribution {
  id: string
  extensions?: string[]
  aliases?: string[]
  filenames?: string[]
  filenamePatterns?: string[]
  mimetypes?: string[]
  /** Path to a `language-configuration.json` file inside the plugin. */
  configurationPath?: string
  /** Parsed configuration when `configurationPath` is provided. */
  configuration?: VsCodeLanguageConfiguration
  /** Path to a 16x16 light icon (optional). */
  iconPathLight?: string
  /** Path to a 16x16 dark icon (optional). */
  iconPathDark?: string
}

export interface VsCodeLanguageConfiguration {
  comments?: {
    lineComment?: string
    blockComment?: [string, string]
  }
  brackets?: Array<[string, string]>
  autoClosingPairs?: Array<{ open: string; close: string; notIn?: string[] }>
  surroundingPairs?: Array<{ open: string; close: string }>
  indentationRules?: {
    increaseIndentPattern?: string
    decreaseIndentPattern?: string
  }
  wordPattern?: string
  folding?: {
    markers?: { start: string; end: string }
  }
}

export interface LanguageContributionRecord extends VsCodeLanguageContribution {
  /** Stable composite id = `${pluginId}.${id}`. */
  contributionId: string
  /** Owning plugin id. */
  pluginId: string
}

const languages = new Map<string, LanguageContributionRecord>()
const listeners = new Set<(event: LanguageEvent) => void>()

export type LanguageEventType = "register" | "unregister"
export interface LanguageEvent {
  type: LanguageEventType
  contribution: LanguageContributionRecord
}

function emit(event: LanguageEvent): void {
  queueMicrotask(() => {
    for (const fn of listeners) {
      try {
        fn(event)
      } catch (err) {
        console.warn("Language listener threw:", err)
      }
    }
  })
}

/**
 * Register a single language contribution. When `configurationText` is
 * provided it's parsed and stored on the record.
 */
export function registerLanguage(input: {
  pluginId: string
  language: VsCodeLanguageContribution
  /** Raw `language-configuration.json` content; parsed and attached. */
  configurationText?: string
}): LanguageContributionRecord {
  const { id } = input.language
  if (!id || typeof id !== "string") {
    throw new Error("languages.id must be a non-empty string")
  }
  let configuration: VsCodeLanguageConfiguration | undefined = input.language.configuration
  if (input.configurationText && !configuration) {
    try {
      configuration = JSON.parse(
        stripJsonComments(input.configurationText)
      ) as VsCodeLanguageConfiguration
    } catch (err) {
      throw new Error(`Invalid language-configuration JSON for "${id}": ${(err as Error).message}`)
    }
  }
  const contributionId = `${input.pluginId}.${id}`
  const existing = languages.get(contributionId)
  if (existing) {
    throw new Error(`Language collision: ${input.pluginId} already contributes language "${id}"`)
  }
  const record: LanguageContributionRecord = {
    ...input.language,
    configuration,
    contributionId,
    pluginId: input.pluginId,
  }
  languages.set(contributionId, record)
  emit({ type: "register", contribution: record })
  return record
}

export function unregisterLanguage(contributionId: string): void {
  const record = languages.get(contributionId)
  if (!record) return
  languages.delete(contributionId)
  emit({ type: "unregister", contribution: record })
}

export function unregisterLanguagesByPlugin(pluginId: string): number {
  let removed = 0
  for (const [id, record] of languages) {
    if (record.pluginId === pluginId) {
      languages.delete(id)
      emit({ type: "unregister", contribution: record })
      removed += 1
    }
  }
  return removed
}

export function listLanguages(): LanguageContributionRecord[] {
  return [...languages.values()]
}

export function getLanguage(contributionId: string): LanguageContributionRecord | undefined {
  return languages.get(contributionId)
}

/**
 * Resolve the language id for a given filename by scanning every
 * registered contribution. Extension match (suffix) and exact filename
 * match are supported.
 */
export function detectLanguage(filename: string): string | undefined {
  const lower = filename.toLowerCase()
  // Filename match compares the basename so `subdir/Makefile` still
  // detects as `make`.
  const basename = lower.split(/[\\/]/).pop() ?? lower
  for (const record of languages.values()) {
    if (record.filenames?.some((name) => name.toLowerCase() === basename)) {
      return record.id
    }
  }
  for (const record of languages.values()) {
    if (record.extensions?.some((ext) => lower.endsWith(ext.toLowerCase()))) {
      return record.id
    }
  }
  for (const record of languages.values()) {
    if (
      record.filenamePatterns?.some((pattern) => {
        try {
          return new RegExp(pattern, "i").test(filename)
        } catch {
          return false
        }
      })
    ) {
      return record.id
    }
  }
  return undefined
}

export function subscribeLanguages(listener: (event: LanguageEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function __resetLanguagesForTesting(): void {
  languages.clear()
  listeners.clear()
}

/**
 * Monaco consumer for VS Code `contributes.languages[]`.
 *
 * `languages-bridge` is the storage; this module is the consumer that makes a
 * contributed language id actually exist in Monaco: `monaco.languages.register`
 * (so file extensions / aliases resolve and LSP / completion providers can bind
 * to the id) plus `setLanguageConfiguration` (brackets, comments, auto-closing
 * pairs, word pattern, indentation, folding).
 *
 * Wired from `vscode-loader.ts` once Monaco is configured (Tauri only — Monaco
 * is a ~3 MB lazy import). It registers everything already in the bridge and
 * subscribes for live register/unregister so enabling / disabling a VS Code
 * extension reflects in the editor without a reload.
 */

import {
  listLanguages,
  subscribeLanguages,
  type LanguageContributionRecord,
  type VsCodeLanguageConfiguration,
} from "@/lib/plugin/bridge/languages-bridge"

/** Minimal slice of `monaco.languages` this consumer needs (keeps it testable). */
export interface MonacoLanguagesApi {
  register: (language: {
    id: string
    extensions?: string[]
    aliases?: string[]
    filenames?: string[]
    filenamePatterns?: string[]
    mimetypes?: string[]
  }) => void
  setLanguageConfiguration: (languageId: string, configuration: unknown) => { dispose: () => void }
}

/** Best-effort string → RegExp; returns undefined on an invalid pattern. */
function toRegExp(pattern?: string): RegExp | undefined {
  if (!pattern) return undefined
  try {
    return new RegExp(pattern)
  } catch {
    return undefined
  }
}

/**
 * Translate the bridge's (string-regex) configuration shape into the object
 * Monaco expects (RegExp fields). Only well-formed fields survive.
 */
export function toMonacoLanguageConfiguration(
  config: VsCodeLanguageConfiguration | undefined
): Record<string, unknown> | undefined {
  if (!config) return undefined
  const out: Record<string, unknown> = {}
  if (config.comments) out.comments = config.comments
  if (config.brackets) out.brackets = config.brackets
  if (config.autoClosingPairs) out.autoClosingPairs = config.autoClosingPairs
  if (config.surroundingPairs) out.surroundingPairs = config.surroundingPairs

  const wordPattern = toRegExp(config.wordPattern)
  if (wordPattern) out.wordPattern = wordPattern

  if (config.indentationRules) {
    const increase = toRegExp(config.indentationRules.increaseIndentPattern)
    const decrease = toRegExp(config.indentationRules.decreaseIndentPattern)
    if (increase && decrease) {
      out.indentationRules = { increaseIndentPattern: increase, decreaseIndentPattern: decrease }
    }
  }

  if (config.folding?.markers) {
    const start = toRegExp(config.folding.markers.start)
    const end = toRegExp(config.folding.markers.end)
    if (start && end) {
      out.folding = { markers: { start, end } }
    }
  }

  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Register one contribution into Monaco and return a disposer that tears down
 * the language configuration (Monaco has no `unregister` for the language id
 * itself, but a re-register is harmless and the configuration is disposable).
 */
function registerOne(
  monacoLanguages: MonacoLanguagesApi,
  record: LanguageContributionRecord
): () => void {
  monacoLanguages.register({
    id: record.id,
    extensions: record.extensions,
    aliases: record.aliases,
    filenames: record.filenames,
    filenamePatterns: record.filenamePatterns,
    mimetypes: record.mimetypes,
  })
  const configuration = toMonacoLanguageConfiguration(record.configuration)
  if (configuration) {
    const handle = monacoLanguages.setLanguageConfiguration(record.id, configuration)
    return () => handle.dispose()
  }
  return () => {}
}

/**
 * Sync every contributed language into Monaco and keep it in sync. Returns a
 * disposer that unsubscribes and tears down all language configurations.
 */
export function installContributedLanguageSync(monacoLanguages: MonacoLanguagesApi): () => void {
  const disposers = new Map<string, () => void>()

  const add = (record: LanguageContributionRecord) => {
    // Re-register is idempotent at the Monaco level; drop any prior config.
    disposers.get(record.contributionId)?.()
    disposers.set(record.contributionId, registerOne(monacoLanguages, record))
  }

  for (const record of listLanguages()) {
    add(record)
  }

  const unsubscribe = subscribeLanguages((event) => {
    if (event.type === "register") {
      add(event.contribution)
    } else {
      disposers.get(event.contribution.contributionId)?.()
      disposers.delete(event.contribution.contributionId)
    }
  })

  return () => {
    unsubscribe()
    for (const dispose of disposers.values()) dispose()
    disposers.clear()
  }
}

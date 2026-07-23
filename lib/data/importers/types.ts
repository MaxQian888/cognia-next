// Shared types for the external-format importers (ChatGPT / Claude / Gemini).

import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"

/** Formats the host itself knows how to sniff and parse. */
export type BuiltInChatImportFormat =
  "chatgpt" | "claude" | "gemini" | "cognia-v3" | "cognia-v1" | "unknown"

/**
 * A plugin-contributed format, always namespaced `${pluginId}:${format}`.
 *
 * The namespace is not decoration: it is what makes the union open without
 * letting a plugin claim (or accidentally collide with) a built-in format —
 * no built-in contains a colon. Before this existed `ChatImportFormat` was a
 * closed union, so the §A-4 overlay's promise that "plugins can contribute new
 * chat-export importers (e.g. a Slack importer)" was one the type system
 * forbade: there was no legal value a plugin importer could put in `format`.
 */
export type PluginChatImportFormat = `${string}:${string}`

export type ChatImportFormat = BuiltInChatImportFormat | PluginChatImportFormat

export interface ImportedConversation {
  session: ChatSession
  messages: StoredMessage[]
  /**
   * Additional conversations produced alongside this one, persisted as
   * top-level rows too (ADR-0062). Claude Code uses this for the hidden
   * `kind: "subagent"` inner-transcript sessions a parent turn drills into.
   * Flattened by `parseSessions` before `applyImported`.
   */
  nested?: ImportedConversation[]
}

export interface ChatImportOptions {
  /** Overwrite the title with this value (used when source has no title). */
  defaultTitle?: string
}

export interface ChatImportResult {
  format: ChatImportFormat
  conversations: ImportedConversation[]
}

export interface ChatImporter<TData = unknown> {
  format: ChatImportFormat
  /**
   * Human-readable name for the import dialog. Built-ins omit it and are
   * labelled by `formatLabel`'s switch; a plugin format has no entry there
   * (nor in the message catalog), so without this its row would show the raw
   * `${pluginId}:${format}` string.
   */
  label?: string
  /** Cheap structural sniff. Run on every parsed JSON candidate. */
  detect: (data: unknown) => data is TData
  /** Convert detected data into our internal conversation shape. */
  parse: (data: TData, opts: ChatImportOptions) => Promise<ImportedConversation[]>
}

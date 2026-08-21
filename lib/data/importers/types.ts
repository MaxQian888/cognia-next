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
  /**
   * File extensions this importer accepts, for the picker's filter. Bare or
   * dotted, case-insensitive. Defaults to `["json"]` when omitted — the three
   * built-ins are all web-export JSON.
   *
   * The picker used to hard-code `["json"]`, which made the §A-4 plugin overlay
   * half-dormant: a plugin could register a Slack/Discord/Poe importer whose
   * export is a `.zip`, `.jsonl` or `.txt`, and the user could not even select
   * the file. Deriving the filter from the registry means a format is pickable
   * the moment it registers, exactly as `getAcceptedPickerExtensions()` does
   * for session sources (ADR-0062).
   */
  extensions?: string[]
  /**
   * Cheap structural sniff. Run on every candidate payload: the parsed JSON
   * when the file is JSON, else the raw file text as a string (so a
   * non-JSON-shaped export is still reachable). Built-ins narrow on
   * `typeof data === "object"` and therefore reject the string form.
   */
  detect: (data: unknown) => data is TData
  /** Convert detected data into our internal conversation shape. */
  parse: (data: TData, opts: ChatImportOptions) => Promise<ImportedConversation[]>
}

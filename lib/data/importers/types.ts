// Shared types for the external-format importers (ChatGPT / Claude / Gemini).

import type { ChatSession, StoredMessage } from "@/lib/claude/types"

export type ChatImportFormat =
  | "chatgpt"
  | "claude"
  | "gemini"
  | "cognia-v3"
  | "cognia-v1"
  | "unknown"

export interface ImportedConversation {
  session: ChatSession
  messages: StoredMessage[]
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
  /** Cheap structural sniff. Run on every parsed JSON candidate. */
  detect: (data: unknown) => data is TData
  /** Convert detected data into our internal conversation shape. */
  parse: (data: TData, opts: ChatImportOptions) => Promise<ImportedConversation[]>
}

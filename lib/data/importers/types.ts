// Shared types for the external-format importers (ChatGPT / Claude / Gemini).

import type {
  ChatImportFormat,
  ImportedConversation,
} from "@cognia/plugin-contract/lib/data/importers/types"
export type {
  BuiltInChatImportFormat,
  ChatImportFormat,
  ChatImportOptions,
  ChatImporter,
  ImportedConversation,
  PluginChatImportFormat,
} from "@cognia/plugin-contract/lib/data/importers/types"

export interface ChatImportResult {
  format: ChatImportFormat
  conversations: ImportedConversation[]
}

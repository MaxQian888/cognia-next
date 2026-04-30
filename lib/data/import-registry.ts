// Dispatcher for external-format conversation imports. Tries each registered
// importer's `detect` predicate in order and returns the first match. Pure
// function — `applyImported` (separate) is what writes to Dexie.

import { detectChatGPT, parseChatGPT } from "./importers/chatgpt-import"
import { detectClaude, parseClaude } from "./importers/claude-import"
import { detectGemini, parseGemini } from "./importers/gemini-import"
import { isEncryptedEnvelope } from "./migrate"
import type {
  ChatImporter,
  ChatImportFormat,
  ChatImportOptions,
  ChatImportResult,
  ImportedConversation,
} from "./importers/types"
import type { ChatSession, StoredMessage } from "@/lib/claude/types"
import { getDb } from "@/lib/db/schema"

const REGISTRY: ChatImporter[] = [
  {
    format: "chatgpt",
    detect: detectChatGPT,
    parse: (data, opts) => parseChatGPT(data as Parameters<typeof parseChatGPT>[0], opts),
  },
  {
    format: "claude",
    detect: detectClaude,
    parse: (data, opts) => parseClaude(data as Parameters<typeof parseClaude>[0], opts),
  },
  {
    format: "gemini",
    detect: detectGemini,
    parse: (data, opts) => parseGemini(data as Parameters<typeof parseGemini>[0], opts),
  },
]

export function detectFormat(data: unknown): ChatImportFormat {
  if (isEncryptedEnvelope(data)) return "unknown"
  if (data && typeof data === "object") {
    const obj = data as { version?: unknown; schemaVersion?: unknown }
    if (obj.version === "3.0") return "cognia-v3"
    if (obj.schemaVersion === 1) return "cognia-v1"
  }
  for (const importer of REGISTRY) {
    if (importer.detect(data)) return importer.format
  }
  return "unknown"
}

/**
 * Detect + parse in one call. Returns conversations + the recognized format.
 * Throws when the format isn't recognized.
 */
export async function importChatExport(
  data: unknown,
  opts: ChatImportOptions = {}
): Promise<ChatImportResult> {
  for (const importer of REGISTRY) {
    if (importer.detect(data)) {
      const conversations = await importer.parse(data, opts)
      return { format: importer.format, conversations }
    }
  }
  throw new Error("Could not recognize the import file format.")
}

/**
 * Persist parsed conversations to Dexie. Each session and its messages are
 * written in a single transaction. Returns counts for the UI.
 */
export async function applyImported(
  conversations: ImportedConversation[]
): Promise<{ sessions: number; messages: number }> {
  if (conversations.length === 0) return { sessions: 0, messages: 0 }
  const db = getDb()
  const sessionRows: ChatSession[] = conversations.map((c) => c.session)
  const messageRows: StoredMessage[] = conversations.flatMap((c) => c.messages)

  await db.transaction("rw", [db.sessions, db.messages], async () => {
    await db.sessions.bulkPut(sessionRows)
    await db.messages.bulkPut(messageRows)
  })

  return { sessions: sessionRows.length, messages: messageRows.length }
}

export type { ChatImportFormat, ChatImportResult, ImportedConversation } from "./importers/types"

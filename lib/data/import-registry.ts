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

// §A-4 — runtime overlay so plugins can contribute new chat-export importers
// (e.g., a Slack-export importer, a Discord importer). The static REGISTRY
// stays authoritative; dynamic importers are appended so static formats win
// when a plugin registers an importer that detects the same format.
interface RegisteredImporter {
  // The importer's parse signature is invariant in `TData` so the registry
  // stores it under the loosest possible type. Public registration is
  // generic — see `registerChatImporter` below — so callers keep their
  // narrow `TData` at the call site.
  importer: ChatImporter<unknown>
  pluginId?: string
}

const dynamicImporters: RegisteredImporter[] = []

/**
 * Register a chat importer at runtime. Dynamic importers are evaluated AFTER
 * the static REGISTRY, so a plugin cannot accidentally shadow one of the
 * three shipping formats. Plugins may register multiple importers.
 *
 * The function is generic so a plugin can register a strongly-typed importer
 * (`registerChatImporter<MyShape>(...)`) without us widening every parse to
 * `ChatImporter<unknown>` at the call site.
 */
export function registerChatImporter<TData>(
  importer: ChatImporter<TData>,
  opts?: { pluginId?: string }
): void {
  dynamicImporters.push({ importer: importer as ChatImporter<unknown>, pluginId: opts?.pluginId })
}

/**
 * Drop a single dynamic importer by reference (e.g., when the plugin returns
 * its registration handle). Returns true when an entry was removed.
 */
export function unregisterChatImporter<TData>(importer: ChatImporter<TData>): boolean {
  const idx = dynamicImporters.findIndex((d) => d.importer === (importer as ChatImporter<unknown>))
  if (idx === -1) return false
  dynamicImporters.splice(idx, 1)
  return true
}

/**
 * Drop every dynamically registered importer tagged with `pluginId`. Returns
 * the number of importers removed.
 */
export function unregisterImportersByPlugin(pluginId: string): number {
  let removed = 0
  for (let i = dynamicImporters.length - 1; i >= 0; i -= 1) {
    if (dynamicImporters[i].pluginId === pluginId) {
      dynamicImporters.splice(i, 1)
      removed += 1
    }
  }
  return removed
}

/** Test-only escape hatch for cleaning up the dynamic overlay between tests. */
export function __resetDynamicImportersForTesting(): void {
  dynamicImporters.length = 0
}

function getImporters(): ChatImporter[] {
  return [...REGISTRY, ...dynamicImporters.map((d) => d.importer)]
}

export function detectFormat(data: unknown): ChatImportFormat {
  if (isEncryptedEnvelope(data)) return "unknown"
  if (data && typeof data === "object") {
    const obj = data as { version?: unknown; schemaVersion?: unknown }
    if (obj.version === "3.0") return "cognia-v3"
    if (obj.schemaVersion === 1) return "cognia-v1"
  }
  for (const importer of getImporters()) {
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
  for (const importer of getImporters()) {
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

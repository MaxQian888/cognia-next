/**
 * Chat result index — one lean row per thing a turn PRODUCED.
 *
 * A sibling of `lib/db/chat-search-text.ts` and built on the same three rules,
 * for the same reasons: one lean row per item, never `parts`; derived data that
 * can be dropped and rebuilt at any moment; written idempotently by primary key
 * so several Tauri WebViews against one IndexedDB overwrite rather than
 * duplicate.
 *
 * It exists because the search projection deliberately drops tool OUTPUTS
 * (`lib/chat/search/project-text.ts` says why), which makes "the thing that
 * came out of the other conversation" the one thing chat history cannot find.
 * Search wants the prose; reuse wants the result. Two questions, two
 * projections — widening the first to answer the second would bury real prose
 * under tool logs in a corpus that has to stay resident.
 *
 * What is stored is a HANDLE plus a preview, never the output itself: a single
 * file read is tens of KB, and this table is enumerated by recency for the `^`
 * picker. The body is read back from the owning message at pick time, which is
 * also what keeps the row correct when the message is edited.
 */

import type { StoredMessage } from "@cognia/agent-config-types"

import { isToolPart, projectToolOutputText } from "@/lib/chat/mentions/tool-output-text"
import { normalizeToolName } from "@/lib/chat/tool-summary"
import { getDb } from "./schema"

/**
 * What produced the result. One member, on purpose.
 *
 * An artifact and a canvas document are also things a turn produces, and both
 * are deliberately NOT here. Their message parts carry a POINTER — an
 * `artifactId` plus a title snapshot (`lib/claude/parts-extensions.ts`) — while
 * the body lives in `useArtifactStore` / `useCanvasStore`, where `@artifact:`
 * already reads it live. Indexing them would put one document behind two doors
 * with two different bodies, and the stale one would be the one inlined into a
 * prompt.
 *
 * A tool output has no other door. That absence is the entire reason this table
 * exists, and it is what the column is discriminating between — so it is
 * declared as a union rather than dropped, and a second member has to arrive
 * with a body the index can actually be the source of.
 */
export type ChatResultKind = "tool"

/** Characters of the output kept on the row for matching and for the row's second line. */
export const RESULT_PREVIEW_MAX_CHARS = 400

export interface ChatResultIndexRow {
  /** `${messageId}:${partIndex}` — stable across re-projection of one message. */
  resultId: string
  messageId: string
  sessionId: string
  /** `""` for pre-isolation rows, never `undefined` — see `ChatSearchTextRow`. */
  projectId: string
  createdAt: number
  kind: ChatResultKind
  /** Tool name, artifact type, or canvas — what this result IS. */
  toolName: string
  /** What it is called: a file path, an artifact title, a command. */
  title: string
  /** Clamped excerpt. The full body is re-read from the message on pick. */
  preview: string
  /** Size of the full output, so a row can say what it is about to inline. */
  bytes: number
  /** Pre-lowercased haystack (`toolName` + `title` + `preview`). */
  searchText: string
}

/** Descending-backfill bookkeeping, mirroring `chatSearchState`. */
export interface ChatResultIndexStateRow {
  id: "singleton"
  oldestProjectedAt: number | null
  oldestProjectedId: string | null
  complete: boolean
  updatedAt: number
}

export const DEFAULT_CHAT_RESULT_INDEX_STATE: ChatResultIndexStateRow = {
  id: "singleton",
  oldestProjectedAt: null,
  oldestProjectedId: null,
  complete: false,
  updatedAt: 0,
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * The most name-like string in a tool's input.
 *
 * A result is recognised by what it was ABOUT — the file that was read, the
 * command that was run — not by the tool that produced it, because a session
 * holds dozens of `Read` results and one of `Read /etc/hosts`.
 */
const TITLE_KEYS = [
  "file_path",
  "filePath",
  "path",
  "command",
  "pattern",
  "query",
  "url",
  "notebook_path",
  "prompt",
] as const

function titleFromInput(input: unknown): string {
  if (typeof input === "string") return input
  if (!isObject(input)) return ""
  for (const key of TITLE_KEYS) {
    const value = input[key]
    if (typeof value === "string" && value) return value
  }
  return ""
}

function clampPreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= RESULT_PREVIEW_MAX_CHARS
    ? flat
    : `${flat.slice(0, RESULT_PREVIEW_MAX_CHARS)}…`
}

function row(input: Omit<ChatResultIndexRow, "searchText">): ChatResultIndexRow {
  return {
    ...input,
    searchText: `${input.toolName} ${input.title} ${input.preview}`.toLocaleLowerCase(),
  }
}

/**
 * Every result one message produced.
 *
 * Indexed by position in `parts`, so re-projecting a message overwrites its own
 * rows rather than accumulating them. A tool call still running produces
 * nothing: a result you cannot read is not a result you can reuse, and offering
 * it would stage an empty chip.
 */
export function projectMessageResults(message: StoredMessage): ChatResultIndexRow[] {
  const parts = message.parts
  if (!Array.isArray(parts)) return []
  const out: ChatResultIndexRow[] = []
  const base = {
    messageId: message.id,
    sessionId: message.sessionId,
    projectId: message.projectId ?? "",
    createdAt: message.createdAt,
  }
  for (const [index, raw] of parts.entries()) {
    // The AI SDK's `UIMessagePart` union does not describe this repo's own part
    // types, so every consumer reads them through a record view — the same cast
    // `message-renderer.tsx` makes before dispatching on `type`.
    const part = raw as unknown as Record<string, unknown>
    if (!isObject(part) || !isToolPart(part)) continue
    const output = projectToolOutputText(part)
    if (!output) continue
    const toolName = normalizeToolName(part as never)
    out.push(
      row({
        ...base,
        resultId: `${message.id}:${index}`,
        kind: "tool",
        toolName,
        title: titleFromInput(part.input) || toolName,
        preview: clampPreview(output),
        bytes: output.length,
      })
    )
  }
  return out
}

export async function putChatResultRows(rows: readonly ChatResultIndexRow[]): Promise<void> {
  if (rows.length === 0) return
  await getDb().chatResultIndex.bulkPut(rows as ChatResultIndexRow[])
}

export async function deleteChatResultsForMessages(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const db = getDb()
  // Keyed by `${messageId}:${index}`, so a message's rows are found by its
  // `messageId` index rather than by reconstructing every possible key.
  const keys = await db.chatResultIndex
    .where("messageId")
    .anyOf(ids as string[])
    .primaryKeys()
  if (keys.length > 0) await db.chatResultIndex.bulkDelete(keys as string[])
}

export async function deleteChatResultsForSession(sessionId: string): Promise<void> {
  await getDb().chatResultIndex.where("sessionId").equals(sessionId).delete()
}

/**
 * Reconcile one session's result rows against a freshly-read message list.
 *
 * Whole-session, like `reprojectSession`, and for the identical reason: edits
 * and truncation REMOVE messages, and an append-only index would keep offering
 * a result whose message no longer renders.
 */
export async function reconcileSessionResults(
  sessionId: string,
  messages: readonly StoredMessage[]
): Promise<{ written: ChatResultIndexRow[]; removed: string[] }> {
  const db = getDb()
  const written = messages.flatMap((message) => projectMessageResults(message))
  const existing = (await db.chatResultIndex
    .where("sessionId")
    .equals(sessionId)
    .primaryKeys()) as string[]
  const keep = new Set(written.map((r) => r.resultId))
  const removed = existing.filter((id) => !keep.has(id))
  if (removed.length > 0) await db.chatResultIndex.bulkDelete(removed)
  await putChatResultRows(written)
  return { written, removed }
}

export async function getChatResultIndexState(): Promise<ChatResultIndexStateRow> {
  const row = await getDb().chatResultIndexState.get("singleton")
  return row ?? DEFAULT_CHAT_RESULT_INDEX_STATE
}

export async function setChatResultIndexState(
  patch: Partial<Omit<ChatResultIndexStateRow, "id" | "updatedAt">>
): Promise<void> {
  const current = await getChatResultIndexState()
  await getDb().chatResultIndexState.put({
    ...current,
    ...patch,
    id: "singleton",
    updatedAt: Date.now(),
  })
}

/**
 * The newest results, newest-first.
 *
 * This is the whole `^` picker: an index walk with a limit, no scan and no
 * scoring. `[createdAt+resultId]` is a total order for the same reason
 * `chatSearchText` needs one — several results routinely share a millisecond,
 * and paging on the timestamp alone would re-read or skip the tied rows.
 */
export async function loadNewestChatResults(limit: number): Promise<ChatResultIndexRow[]> {
  if (limit <= 0) return []
  return getDb().chatResultIndex.orderBy("[createdAt+resultId]").reverse().limit(limit).toArray()
}

/**
 * Newest results whose haystack contains `needle`.
 *
 * Paged newest-first and stopped as soon as the page is full, so a matching
 * recent result never costs a walk of the account's history. `needle` is
 * matched pre-lowercased against the row's own `searchText`.
 */
export async function searchChatResults(
  needle: string,
  limit: number,
  { scanLimit = 5_000 }: { scanLimit?: number } = {}
): Promise<ChatResultIndexRow[]> {
  if (limit <= 0) return []
  const lowered = needle.toLocaleLowerCase()
  if (!lowered) return loadNewestChatResults(limit)
  const out: ChatResultIndexRow[] = []
  let scanned = 0
  const PAGE = 500
  let cursor: [number, string] | null = null
  for (;;) {
    const table = getDb().chatResultIndex.orderBy("[createdAt+resultId]")
    const page: ChatResultIndexRow[] = cursor
      ? await getDb()
          .chatResultIndex.where("[createdAt+resultId]")
          .below(cursor)
          .reverse()
          .limit(PAGE)
          .toArray()
      : await table.reverse().limit(PAGE).toArray()
    if (page.length === 0) return out
    for (const row of page) {
      scanned++
      if (row.searchText.includes(lowered)) {
        out.push(row)
        if (out.length >= limit) return out
      }
    }
    // A bound, not a correctness rule: without it a needle that matches nothing
    // walks every result ever produced on a keystroke.
    if (scanned >= scanLimit || page.length < PAGE) return out
    const last = page[page.length - 1]
    cursor = [last.createdAt, last.resultId]
  }
}

export async function countChatResults(): Promise<number> {
  return getDb().chatResultIndex.count()
}

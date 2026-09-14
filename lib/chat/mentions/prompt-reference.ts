/**
 * `@prompt:` — something the user typed and sent, found by what it says.
 *
 * `@msg:` already reaches every message, so this is a namespace of its own for
 * what it leaves out. A message reference is the exchange as the model saw it:
 * the context envelope noted, tool output inlined, and the whole body wrapped
 * as untrusted, because anyone's words can sit in a transcript. A prompt is the
 * user's own words and nothing else, and the two things people do with an old
 * prompt are both about those words: cite it, or send it again. The second is
 * why a candidate carries `insertText` — the composer's panel can put the words
 * back in the draft instead of staging a chip.
 *
 * "The user typed it" is checked here, not assumed from the `user` role. An IM
 * connector stores a message from someone else in the group as `user`, and a
 * shared session does the same for every participant. Both record their author,
 * so a row counts as a prompt only when `resolveMessageSpeaker` — the one
 * authorship resolver the transcript and the prompt builders share — finds
 * nobody behind it. That check is also why a prompt is not wrapped as untrusted
 * content: the rule that admits a row is the rule that makes it the user's.
 * A shared session's turns stay out with the rest, since this device cannot
 * tell which of its authors is the person using it.
 *
 * The typed words are what the transcript's own edit and quote actions hand
 * over (`extractText` in `components/chat/message-renderer.tsx`): the text parts
 * with the context envelope removed. A turn that carried more than its words
 * says so in the staged body, for the reason `@msg:` does — "compare these two"
 * without the two must not read as a question about nothing. The inserted draft
 * is the words alone.
 */

import type { EntityMentionCandidate, EntityMentionContext } from "./entity-sources"
import { ENTITY_MENTION_RESULT_LIMIT, listableSessionTitles } from "./entity-sources"
import { contentFingerprint } from "./content-fingerprint"
import {
  REFERENCE_PREAMBLE_OMITTED_NOTE,
  messageRefId,
  parseMessageRefId,
} from "./message-reference"
import { promptPreambleOfParts, stripPromptPreambleFromParts } from "@/lib/chat/prompt-preamble"
import { resolveMessageSpeaker, type SpeakerSource } from "@/lib/chat/speaker"
import { messagePermalinkQuery } from "@/lib/chat/message-permalink"
import { selectionTitleFor } from "@/lib/chat/selection/selection-text"
import { stripSteerPrefix } from "@/lib/claude/steer"

/** Longest a prompt runs as its own row title before it is elided. */
export const PROMPT_TITLE_MAX = 120

/**
 * Rows read for every row offered.
 *
 * Some rows fall out after the read: another person's message under the `user`
 * role, a turn that was only an attachment, and the same words sent again
 * ("continue", "try again"), which the panel shows once. Reading four times the
 * page keeps the list full through a history thick with those.
 */
export const PROMPT_CANDIDATE_OVERFETCH = 4

/**
 * Most search-index rows the empty `@prompt:` list examines.
 *
 * The recent list walks the index newest-first for `user` rows. In a workspace
 * with no prompt among its newest messages that walk would otherwise read the
 * whole history on every open; past this many rows the list shows what it
 * found, and typing a query reaches older history through the search engine.
 */
export const PROMPT_RECENT_SCAN_BUDGET = 5_000

/** The message fields a prompt is read from. Structural, so a stored row fits. */
export interface PromptMessageRow extends SpeakerSource {
  id: string
  sessionId: string
  role: string
  parts: unknown
  createdAt: number
}

export interface TypedPrompt {
  /** The words, newlines intact. Empty when the turn had none. */
  text: string
  /** The turn was sent with more than the words: a context envelope or attachments. */
  carriedMore: boolean
}

/** What the user typed into a turn. */
export function typedPromptOf(parts: unknown): TypedPrompt {
  if (!Array.isArray(parts)) return { text: "", carriedMore: false }
  let carriedMore = promptPreambleOfParts(parts) !== null
  const texts: string[] = []
  for (const part of stripPromptPreambleFromParts(parts)) {
    if (!part || typeof part !== "object") continue
    const { type, text } = part as { type?: unknown; text?: unknown }
    if (type === "text") {
      if (typeof text === "string" && text.trim()) texts.push(text)
    } else if (type === "file" || type === "image") {
      carriedMore = true
    }
  }
  // A follow-up typed while a turn was running can be stored with the
  // model-facing steer framing in front of it. That is the app's sentence, not
  // the user's.
  return { text: stripSteerPrefix(texts.join("\n\n").trim()).trim(), carriedMore }
}

/** Is this row something the person using this device typed? */
export function isOwnPrompt(row: SpeakerSource): boolean {
  return row.role === "user" && resolveMessageSpeaker(row) === null
}

export interface PromptRecord {
  sessionId: string
  messageId: string
  createdAt: number
  text: string
  carriedMore: boolean
}

/**
 * The prompt a stored row holds, or null when it holds none — gone, in another
 * conversation than the reference says, someone else's, or no words at all.
 */
export function promptRecordOf(
  row: PromptMessageRow | null | undefined,
  sessionId: string
): PromptRecord | null {
  if (!row || row.sessionId !== sessionId || !isOwnPrompt(row)) return null
  const typed = typedPromptOf(row.parts)
  if (!typed.text) return null
  return {
    sessionId: row.sessionId,
    messageId: row.id,
    createdAt: row.createdAt,
    text: typed.text,
    carriedMore: typed.carriedMore,
  }
}

/** Read one prompt by its reference id (`<sessionId>#<messageId>`). */
export async function readPromptRecord(refId: string): Promise<PromptRecord | null> {
  const parsed = parseMessageRefId(refId)
  if (!parsed) return null
  const { getDb } = await import("@/lib/db/schema")
  const row = (await getDb().messages.get(parsed.messageId)) as PromptMessageRow | undefined
  return promptRecordOf(row, parsed.sessionId)
}

/** The body a staged `@prompt:` chip carries. */
export function promptReferenceBody(record: PromptRecord): string {
  return record.carriedMore ? `${record.text}\n\n${REFERENCE_PREAMBLE_OMITTED_NOTE}` : record.text
}

/** The body to stage for a reference id, or null when there is no prompt there any more. */
export async function promptReferenceText(refId: string): Promise<string | null> {
  const record = await readPromptRecord(refId)
  return record ? promptReferenceBody(record) : null
}

/**
 * The prompt's version: when it was sent plus a digest of exactly the body a
 * chip stages, so an edit to the words — and nothing else — makes a chip stale.
 */
export async function promptFingerprint(refId: string): Promise<string | null> {
  const record = await readPromptRecord(refId)
  return record ? `${record.createdAt}:${contentFingerprint(promptReferenceBody(record))}` : null
}

/** One `@prompt:` row. Titled by the words, because they are what a person recognises. */
export function promptCandidate(
  record: PromptRecord,
  sessionTitle: string
): EntityMentionCandidate {
  const date = new Date(record.createdAt).toISOString().slice(0, 10)
  return {
    entityKind: "prompt",
    id: messageRefId(record.sessionId, record.messageId),
    title: selectionTitleFor(record.text, PROMPT_TITLE_MAX),
    subtitle: `${sessionTitle} · ${date}`,
    href: `/${messagePermalinkQuery({ sessionId: record.sessionId, messageId: record.messageId })}`,
    sourceSessionId: record.sessionId,
    searchText: `${record.text} ${sessionTitle}`.toLocaleLowerCase(),
    insertText: record.text,
  }
}

interface PromptHit {
  sessionId: string
  messageId: string
  sessionTitle: string
}

/** The same words, however they were spaced, are one prompt. */
function promptIdentity(text: string): string {
  return text.replace(/\s+/g, " ")
}

/**
 * Candidates for `@prompt:` — the newest prompts for an empty query, the
 * engine's ranked `user` hits otherwise.
 *
 * The caller owns the short-query floor and the index flush, as it does for
 * `@msg:`; this reads rows and applies the rules that are the prompt's own.
 */
export async function searchOwnPrompts(
  query: string,
  ctx: EntityMentionContext
): Promise<EntityMentionCandidate[]> {
  const wanted = ENTITY_MENTION_RESULT_LIMIT * PROMPT_CANDIDATE_OVERFETCH
  const hits = query
    ? await rankedPromptHits(query, ctx, wanted)
    : await recentPromptHits(ctx, wanted)
  if (hits.length === 0) return []

  const { getDb } = await import("@/lib/db/schema")
  const rows = (await getDb().messages.bulkGet(hits.map((hit) => hit.messageId))) as (
    PromptMessageRow | undefined
  )[]
  const seen = new Set<string>()
  const candidates: EntityMentionCandidate[] = []
  for (const [index, hit] of hits.entries()) {
    if (candidates.length >= ENTITY_MENTION_RESULT_LIMIT) break
    // A row the index knows and Dexie does not (the turn is still being
    // written) has no words to offer yet.
    const record = promptRecordOf(rows[index], hit.sessionId)
    if (!record) continue
    const identity = promptIdentity(record.text)
    if (seen.has(identity)) continue
    seen.add(identity)
    candidates.push(promptCandidate(record, hit.sessionTitle))
  }
  return candidates
}

async function rankedPromptHits(
  query: string,
  ctx: EntityMentionContext,
  wanted: number
): Promise<PromptHit[]> {
  const [{ searchChatHistory }, { pendingSearchRows }] = await Promise.all([
    import("@/lib/chat/search/engine"),
    import("@/lib/chat/search/pending-rows"),
  ])
  const outcome = await searchChatHistory(
    {
      query,
      limit: wanted,
      roles: ["user"],
      // The same prompt in two conversations is two hits, and which one is the
      // better match is the engine's call, not a per-conversation cap's.
      collapseBySession: false,
      ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    },
    { pendingRows: pendingSearchRows }
  )
  return outcome.results.map((hit) => ({
    sessionId: hit.sessionId,
    messageId: hit.messageId,
    sessionTitle: hit.sessionTitle || hit.sessionId,
  }))
}

async function recentPromptHits(ctx: EntityMentionContext, wanted: number): Promise<PromptHit[]> {
  const { scanOlderChatSearchText } = await import("@/lib/db/chat-search-text")
  const rows: { sessionId: string; messageId: string }[] = []
  let examined = 0
  await scanOlderChatSearchText(Number.MAX_SAFE_INTEGER, (row) => {
    examined++
    // A pre-isolation row (`projectId: ""`) stays reachable from inside a
    // workspace, as it does for `@msg:`.
    if (
      row.role === "user" &&
      (!ctx.projectId || !row.projectId || row.projectId === ctx.projectId)
    ) {
      rows.push({ sessionId: row.sessionId, messageId: row.messageId })
    }
    return rows.length < wanted && examined < PROMPT_RECENT_SCAN_BUDGET
  })
  // The index rows know nothing about exposure or archiving; the engine path
  // applies both itself.
  const titles = await listableSessionTitles(rows.map((row) => row.sessionId))
  return rows.flatMap((row) => {
    const sessionTitle = titles.get(row.sessionId)
    return sessionTitle === undefined ? [] : [{ ...row, sessionTitle }]
  })
}

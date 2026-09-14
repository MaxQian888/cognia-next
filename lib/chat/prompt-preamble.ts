/**
 * The context block the composer prepends to a user turn, and how every reader
 * that wants "what the user typed" gets past it.
 *
 * Three things ride in front of the typed text: review receipts, the staged
 * `Referenced context:` chips, and proactive web-search results. They have to
 * stay IN the persisted message — the standalone engine rebuilds every later
 * turn from the saved rows (`lib/ai/chat/standalone-engine.ts`), so a block that
 * lived only in the provider payload would vanish from a BYOK model's view one
 * turn later. But the bubble, the edit draft, the title, the search index and a
 * `@msg:` body all want the user's own words, and they used to get the whole
 * machine-written block instead.
 *
 * The boundary is written INTO the text as a nonce-tagged envelope rather than
 * carried beside it. A user row is rebuilt from content alone on several paths
 * that cannot carry extra metadata — the steer queue, a shared collaboration
 * publish, a turn a paired phone hands to its Host — and every one of those
 * would otherwise lose the boundary. `lib/claude/steer.ts` made the same choice
 * for its model-only prefix. The nonce is what keeps a referenced document that
 * happens to contain the closing tag from ending the block early.
 *
 * What was attached (kinds, titles, links) is additionally recorded as
 * `metadata.promptPreamble` wherever the send path owns the row, so the bubble
 * can say "3 references" instead of only "context attached". A row without it —
 * a legacy one, or one persisted by a Host — still strips correctly and shows
 * the generic form.
 */

import type { SendContent } from "@cognia/agent-config-types"
import type { ContextRef } from "@/lib/chat/mentions/types"
import type {
  ContextSelectionRef,
  EntitySelectionKind,
  EntitySelectionRef,
} from "@/types/artifact/artifact"

/** Between two sections inside the envelope — the separator the composer always used. */
export const PROMPT_PREAMBLE_SECTION_SEPARATOR = "\n\n---\n\n"

const TAG_PREFIX = "cognia_context_"

/** `<cognia_context_ab12cd34ef>` + newline, anchored at the very start. */
const OPEN_TAG = /^<cognia_context_([0-9a-z]{6,32})>\n/

/**
 * The one sentence of framing inside the envelope.
 *
 * English, like all prompt scaffolding in this repo: it is read by the model,
 * not shown to the user. It replaces the old `User question: ` label, which only
 * the web-search variant carried and which leaked into the bubble.
 */
export const PROMPT_PREAMBLE_FRAMING =
  "Context the app attached to the user's message. The user's own message follows after the closing tag."

export type PromptPreambleSectionKind = "reviewReceipts" | "references" | "webSearch"

export interface PromptPreambleSection {
  kind: PromptPreambleSectionKind
  text: string
}

/**
 * Stable order, independent of the order a caller happens to build sections in.
 * Receipts first because they answer the previous turn; web results last because
 * they are the freshest material and sit nearest the question.
 */
const SECTION_ORDER: readonly PromptPreambleSectionKind[] = [
  "reviewReceipts",
  "references",
  "webSearch",
]

function randomNonce(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(6)
    cryptoApi.getRandomValues(bytes)
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  }
  return Math.random().toString(36).slice(2, 14).padEnd(12, "0")
}

export interface ComposedTurnText {
  /** The full text handed to the send path: envelope (when any) + typed text. */
  text: string
  /** The envelope alone, or `""` when no section had content. */
  preamble: string
  /** Kinds that actually contributed, in envelope order. */
  sections: PromptPreambleSectionKind[]
}

/**
 * Build a turn's text from the typed message and whatever sections apply.
 *
 * Sections with blank text are dropped, and with none left the typed text comes
 * back untouched — a turn with nothing attached must be byte-identical to what
 * it was before this module existed.
 */
export function composeTurnText(
  typed: string,
  sections: readonly PromptPreambleSection[],
  { nonce = randomNonce() }: { nonce?: string } = {}
): ComposedTurnText {
  const present = SECTION_ORDER.flatMap((kind) =>
    sections.filter((s) => s.kind === kind && s.text.trim().length > 0)
  )
  if (present.length === 0) return { text: typed, preamble: "", sections: [] }
  const tag = `${TAG_PREFIX}${nonce}`
  const preamble = [
    `<${tag}>`,
    PROMPT_PREAMBLE_FRAMING,
    "",
    present.map((s) => s.text.trim()).join(PROMPT_PREAMBLE_SECTION_SEPARATOR),
    `</${tag}>`,
  ].join("\n")
  const body = typed.trim()
  return {
    text: body ? `${preamble}\n\n${typed}` : preamble,
    preamble,
    sections: [...new Set(present.map((s) => s.kind))],
  }
}

export interface SplitTurnText {
  /** The envelope, exactly as persisted, or null when the text has none. */
  preamble: string | null
  /** What the user typed. The whole text when there is no envelope. */
  body: string
}

/**
 * Separate the envelope from the typed text.
 *
 * A text whose envelope never closes — truncated in transit, or a user who typed
 * an opening tag — is returned whole. Swallowing the message to the end would be
 * the worse failure: the user's words would disappear from their own bubble.
 */
export function splitPromptPreamble(text: string): SplitTurnText {
  const open = OPEN_TAG.exec(text)
  if (!open) return { preamble: null, body: text }
  const close = `\n</${TAG_PREFIX}${open[1]}>`
  const at = text.indexOf(close, open[0].length)
  if (at < 0) return { preamble: null, body: text }
  const end = at + close.length
  return { preamble: text.slice(0, end), body: text.slice(end).replace(/^\n\n?/, "") }
}

/** The typed text alone. */
export function stripPromptPreamble(text: string): string {
  return splitPromptPreamble(text).body
}

/** The sections inside an envelope, without the tags and the framing line. */
export function promptPreambleInnerText(preamble: string): string {
  const open = OPEN_TAG.exec(preamble)
  if (!open) return preamble
  const close = `\n</${TAG_PREFIX}${open[1]}>`
  const end = preamble.lastIndexOf(close)
  const inner = preamble.slice(open[0].length, end < 0 ? undefined : end)
  return inner.startsWith(`${PROMPT_PREAMBLE_FRAMING}\n\n`)
    ? inner.slice(PROMPT_PREAMBLE_FRAMING.length + 2)
    : inner
}

interface TextLikePart {
  type?: unknown
  text?: unknown
}

function isTextPart(part: unknown): part is TextLikePart & { type: "text"; text: string } {
  return (
    !!part &&
    typeof part === "object" &&
    (part as TextLikePart).type === "text" &&
    typeof (part as TextLikePart).text === "string"
  )
}

/**
 * Only the FIRST text part can carry an envelope: the composer prepends it to
 * the typed text, attachments come before it as file parts, and link context is
 * appended after it. Looking further would let a later part that merely quotes
 * an envelope (a pasted transcript) be stripped.
 */
function firstTextIndex(parts: readonly unknown[]): number {
  return parts.findIndex(isTextPart)
}

/** The envelope carried by a message's parts, or null. */
export function promptPreambleOfParts(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null
  const index = firstTextIndex(parts)
  if (index < 0) return null
  return splitPromptPreamble((parts[index] as { text: string }).text).preamble
}

/**
 * The parts with the envelope removed from the first text part. A part that was
 * nothing but the envelope is dropped rather than left as an empty bubble line.
 *
 * Returns the SAME array when there is nothing to strip, so a memoised consumer
 * does not re-render for every message that never had an envelope.
 */
export function stripPromptPreambleFromParts<T>(parts: readonly T[]): readonly T[] {
  const index = firstTextIndex(parts)
  if (index < 0) return parts
  const part = parts[index] as unknown as { text: string }
  const { preamble, body } = splitPromptPreamble(part.text)
  if (preamble === null) return parts
  const next = [...parts]
  if (body.length === 0) next.splice(index, 1)
  else next[index] = { ...(parts[index] as object), text: body } as T
  return next
}

/** `SendContent` with the envelope removed — for titling and other text-only readers. */
export function stripPromptPreambleFromContent(content: SendContent): SendContent {
  if (typeof content === "string") return stripPromptPreamble(content)
  const index = content.findIndex((block) => block.type === "text")
  if (index < 0) return content
  const block = content[index] as { type: "text"; text: string }
  const { preamble, body } = splitPromptPreamble(block.text)
  if (preamble === null) return content
  const next = [...content]
  if (body.length === 0) next.splice(index, 1)
  else next[index] = { ...block, text: body }
  return next
}

// ---------------------------------------------------------------------------
// The summary recorded beside the row
// ---------------------------------------------------------------------------

/** One attached reference, as the bubble names it. */
export interface PromptPreambleReference {
  kind: ContextSelectionRef["kind"]
  /** Present for `entity` references. */
  entityKind?: EntitySelectionKind
  title: string
  href?: string
  /** Messages folded into one combined reference, when more than one. */
  count?: number
}

export interface PromptPreambleSummary {
  sections: PromptPreambleSectionKind[]
  references: PromptPreambleReference[]
}

function referenceTitle(selection: ContextSelectionRef): string {
  switch (selection.kind) {
    case "file":
      return selection.relPath
    case "external":
      return selection.sourceTitle || selection.sourceApp
    default:
      return selection.title
  }
}

/** What a staged selection is called in the summary. Never its body. */
export function summarizeSelectionForPreamble(
  selection: ContextSelectionRef
): PromptPreambleReference {
  const entity = selection.kind === "entity" ? (selection as EntitySelectionRef) : null
  const href = entity?.href ?? (selection.kind === "web" ? selection.url : undefined)
  const count = entity?.members && entity.members.length > 1 ? entity.members.length : undefined
  return {
    kind: selection.kind,
    ...(entity ? { entityKind: entity.entityKind } : {}),
    title: referenceTitle(selection),
    ...(href ? { href } : {}),
    ...(count ? { count } : {}),
  }
}

const SECTION_KINDS: ReadonlySet<string> = new Set(SECTION_ORDER)

/**
 * Read `metadata.promptPreamble` defensively. Metadata is persisted and synced,
 * so an older build or another device may have written anything there, and a
 * malformed value must read as "no summary" rather than break the transcript.
 */
export function readPromptPreambleSummary(metadata: unknown): PromptPreambleSummary | null {
  if (!metadata || typeof metadata !== "object") return null
  const raw = (metadata as { promptPreamble?: unknown }).promptPreamble
  if (!raw || typeof raw !== "object") return null
  const { sections, references } = raw as { sections?: unknown; references?: unknown }
  if (!Array.isArray(sections) || !Array.isArray(references)) return null
  return {
    sections: sections.filter(
      (s): s is PromptPreambleSectionKind => typeof s === "string" && SECTION_KINDS.has(s)
    ),
    references: references.flatMap((r): PromptPreambleReference[] => {
      if (!r || typeof r !== "object") return []
      const ref = r as Record<string, unknown>
      if (typeof ref.kind !== "string" || typeof ref.title !== "string") return []
      return [
        {
          kind: ref.kind as PromptPreambleReference["kind"],
          title: ref.title,
          ...(typeof ref.entityKind === "string"
            ? { entityKind: ref.entityKind as EntitySelectionKind }
            : {}),
          ...(typeof ref.href === "string" ? { href: ref.href } : {}),
          ...(typeof ref.count === "number" && ref.count > 1 ? { count: ref.count } : {}),
        },
      ]
    }),
  }
}

// ---------------------------------------------------------------------------
// Editing a turn that carried an envelope
// ---------------------------------------------------------------------------

/**
 * `edited` with the original turn's envelope put back in front of it.
 *
 * Every edit surface drafts from the typed text alone, so an edit-and-resend
 * would otherwise silently drop the references the question was asked about —
 * "compare these two" re-sent with nothing to compare. The envelope is reused
 * verbatim (same snapshot the user approved the first time), not rebuilt from
 * the records' current state. Content that already opens with an envelope is
 * returned as is.
 */
export function carryPromptPreamble(originalParts: unknown, edited: SendContent): SendContent {
  const preamble = promptPreambleOfParts(originalParts)
  if (!preamble) return edited
  const prepend = (text: string): string =>
    splitPromptPreamble(text).preamble !== null
      ? text
      : text.trim()
        ? `${preamble}\n\n${text}`
        : preamble
  if (typeof edited === "string") return prepend(edited)
  const index = edited.findIndex((block) => block.type === "text")
  if (index < 0) return [...edited, { type: "text", text: preamble }]
  const next = [...edited]
  const block = edited[index] as { type: "text"; text: string }
  next[index] = { ...block, text: prepend(block.text) }
  return next
}

/** The chip-style citations a persisted turn made, for re-sending it. */
export function chipCitationsOf(metadata: unknown): ContextRef[] {
  if (!metadata || typeof metadata !== "object") return []
  const mentions = (metadata as { mentions?: unknown }).mentions
  if (!Array.isArray(mentions)) return []
  return mentions.filter(
    (ref): ref is ContextRef =>
      !!ref &&
      typeof ref === "object" &&
      typeof (ref as { id?: unknown }).id === "string" &&
      ((ref as { kind?: unknown }).kind === "entity" || (ref as { kind?: unknown }).kind === "doc")
  )
}

/** Where a message's envelope sits: its part, the envelope, and what follows it. */
export interface LocatedPromptPreamble {
  index: number
  preamble: string
  body: string
}

/**
 * Locate the envelope without removing the part — for a renderer that keys
 * parts by index (anchors, galleries and tool groups all do), where dropping a
 * part would shift every position after it.
 */
export function locatePromptPreamble(parts: unknown): LocatedPromptPreamble | null {
  if (!Array.isArray(parts)) return null
  const index = firstTextIndex(parts)
  if (index < 0) return null
  const { preamble, body } = splitPromptPreamble((parts[index] as { text: string }).text)
  return preamble === null ? null : { index, preamble, body }
}
